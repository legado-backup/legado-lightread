//! 应用内下载新版本安装包 (Android 用; 桌面仍走前端的 `downloadInstaller`).
//!
//! 安装包 70 MB 左右, 交给 WebView 在内存里拼接再写文件既慢又容易爆内存, 这里由 Rust
//! 直接流式写进应用缓存目录 `cache/updates/`, 边下边算 SHA-256, 用 Channel 回报进度。
//! 选源 (GitHub / GitCode)、回退顺序、与 SHA256SUMS 比对都在前端 `src/services/updater.ts`:
//!
//!  1. `update_download` 下载一次: 先写 `<name>.part`; 连不上 / 卡住 / 截断都直接报错,
//!     由前端换下一个源。GitHub 在国内常常连得上但只有几十 KB/s, 所以第一次尝试还带
//!     「起步太慢」规则 (`min_rate`): 开始 10 秒后平均速度不够就放弃, 换 GitCode。
//!  2. 前端比对校验值后调用 `update_finish`: 通过则改名为 `<name>` (只有校验过的文件
//!     才会以 `.apk` 结尾, MainActivity 的安装桥只认这种文件), 不通过则删除。
//!
//! 错误字符串以 `timeout:` / `slow:` / `network:` / `http:` / `file:` / `request:` 前缀区分。

use std::{
  io::Write,
  path::{Path, PathBuf},
  time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, AppHandle, Manager};

const UPDATE_DIR: &str = "updates";
const PART_SUFFIX: &str = ".part";
/// 进度最多每 200 ms 回报一次
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
  pub received: u64,
  /// 0 = 服务器没给长度
  pub total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloaded {
  pub sha256: String,
  pub size: u64,
}

/// 只允许普通文件名: 不含路径分隔符、冒号、控制字符, 不以 `.` 开头
pub fn safe_name(name: &str) -> Option<&str> {
  let ok = !name.is_empty()
    && name.len() <= 200
    && !name.starts_with('.')
    && !name.ends_with(PART_SUFFIX)
    && name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'));
  ok.then_some(name)
}

fn update_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| format!("file: 无法定位缓存目录: {e}"))?
    .join(UPDATE_DIR);
  std::fs::create_dir_all(&dir).map_err(|e| format!("file: {e}"))?;
  Ok(dir)
}

/// 清掉上次留下的安装包与半截文件
fn clear_dir(dir: &Path) {
  if let Ok(entries) = std::fs::read_dir(dir) {
    for entry in entries.flatten() {
      let _ = std::fs::remove_file(entry.path());
    }
  }
}

fn map_err(e: reqwest::Error) -> String {
  if e.is_timeout() {
    return format!("timeout: {e}");
  }
  let mut msg = format!("network: {e}");
  let mut source = std::error::Error::source(&e);
  while let Some(s) = source {
    msg.push_str(&format!(": {s}"));
    source = s.source();
  }
  msg
}

/// 起步太慢就放弃: 收到响应头 `window` 之后平均速度仍低于 `bytes_per_sec` (换更快的源)
#[derive(Debug, Clone, Copy)]
pub struct MinRate {
  pub window: Duration,
  pub bytes_per_sec: u64,
}

/// 下载 `url` 到 `dest`, 返回 (SHA-256 十六进制, 字节数). 与 Tauri 无关, 便于单测。
pub async fn fetch_to_file(
  url: &str,
  dest: &Path,
  connect: Duration,
  stall: Duration,
  min_rate: Option<MinRate>,
  proxy: Option<&str>,
  mut on_progress: impl FnMut(UpdateProgress),
) -> Result<(String, u64), String> {
  let mut builder = reqwest::Client::builder().connect_timeout(connect);
  if let Some(proxy) = proxy.map(str::trim).filter(|p| !p.is_empty()) {
    builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("request: 代理地址无效: {e}"))?);
  }
  let client = builder.build().map_err(|e| format!("request: {e}"))?;
  let request = client
    .get(url)
    .header(reqwest::header::ACCEPT, "application/octet-stream")
    .header(reqwest::header::USER_AGENT, "LightRead-Updater");
  // 跟随重定向直到拿到响应头, 整体不超过 connect
  let mut res = tokio::time::timeout(connect, request.send())
    .await
    .map_err(|_| "timeout: 连接超时".to_string())?
    .map_err(map_err)?;
  if !res.status().is_success() {
    return Err(format!("http: {}", res.status().as_u16()));
  }
  let total = res.content_length().unwrap_or(0);
  let mut file = std::fs::File::create(dest).map_err(|e| format!("file: {e}"))?;
  let mut hasher = Sha256::new();
  let mut received = 0u64;
  let started = Instant::now();
  let mut rate_checked = min_rate.is_none();
  let mut last_report = Instant::now();
  on_progress(UpdateProgress { received, total });
  loop {
    let chunk = tokio::time::timeout(stall, res.chunk())
      .await
      .map_err(|_| "timeout: 下载卡住".to_string())?
      .map_err(map_err)?;
    let Some(chunk) = chunk else { break };
    file.write_all(&chunk).map_err(|e| format!("file: {e}"))?;
    hasher.update(&chunk);
    received += chunk.len() as u64;
    if let (false, Some(rate)) = (rate_checked, min_rate) {
      let elapsed = started.elapsed();
      if elapsed >= rate.window {
        rate_checked = true;
        let done = total != 0 && received >= total;
        if !done && (received as f64) < rate.bytes_per_sec as f64 * elapsed.as_secs_f64() {
          return Err(format!("slow: {} 秒只收到 {received} 字节", elapsed.as_secs()));
        }
      }
    }
    if last_report.elapsed() >= PROGRESS_INTERVAL {
      last_report = Instant::now();
      on_progress(UpdateProgress { received, total });
    }
  }
  file.flush().map_err(|e| format!("file: {e}"))?;
  file.sync_all().map_err(|e| format!("file: {e}"))?;
  on_progress(UpdateProgress { received, total });
  // 截断的响应不交给安装器, 由前端换源
  if total != 0 && received != total {
    return Err(format!("network: 只收到 {received} / {total} 字节"));
  }
  let digest = hasher.finalize();
  Ok((digest.iter().map(|b| format!("{b:02x}")).collect(), received))
}

/// 下载一次到 `cache/updates/<name>.part`. 开始前清空目录 (旧安装包 / 半截文件)。
#[tauri::command]
pub async fn update_download(
  app: AppHandle,
  url: String,
  file_name: String,
  connect_ms: u64,
  stall_ms: u64,
  min_rate: Option<u64>,
  rate_window_ms: Option<u64>,
  proxy: Option<String>,
  on_progress: Channel<UpdateProgress>,
) -> Result<UpdateDownloaded, String> {
  if !url.starts_with("https://") {
    return Err("request: 只允许 https 地址".into());
  }
  let name = safe_name(&file_name).ok_or_else(|| format!("request: 不允许的文件名 {file_name}"))?;
  let dir = update_dir(&app)?;
  clear_dir(&dir);
  let part = dir.join(format!("{name}{PART_SUFFIX}"));
  let result = fetch_to_file(
    &url,
    &part,
    Duration::from_millis(connect_ms.clamp(1_000, 120_000)),
    Duration::from_millis(stall_ms.clamp(1_000, 300_000)),
    min_rate.filter(|r| *r > 0).map(|bytes_per_sec| MinRate {
      window: Duration::from_millis(rate_window_ms.unwrap_or(10_000).clamp(1_000, 120_000)),
      bytes_per_sec,
    }),
    proxy.as_deref(),
    |p| {
      let _ = on_progress.send(p);
    },
  )
  .await;
  match result {
    Ok((sha256, size)) => Ok(UpdateDownloaded { sha256, size }),
    Err(e) => {
      let _ = std::fs::remove_file(&part);
      Err(e)
    }
  }
}

/// 校验通过 (`accept`) 时把 `.part` 改名为正式文件并返回其路径; 否则删除, 返回 None。
#[tauri::command]
pub fn update_finish(app: AppHandle, file_name: String, accept: bool) -> Result<Option<String>, String> {
  let name = safe_name(&file_name).ok_or_else(|| format!("request: 不允许的文件名 {file_name}"))?;
  let dir = update_dir(&app)?;
  finish_in(&dir, name, accept)
}

pub fn finish_in(dir: &Path, name: &str, accept: bool) -> Result<Option<String>, String> {
  let part = dir.join(format!("{name}{PART_SUFFIX}"));
  if !accept {
    let _ = std::fs::remove_file(&part);
    return Ok(None);
  }
  let target = dir.join(name);
  std::fs::rename(&part, &target).map_err(|e| format!("file: {e}"))?;
  Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Read;
  use std::net::TcpListener;

  fn serve_once(body: Vec<u8>, declared_len: usize, stall_after: Option<usize>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut buf = [0u8; 1024];
      let _ = stream.read(&mut buf);
      let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {declared_len}\r\nConnection: close\r\n\r\n");
      stream.write_all(head.as_bytes()).unwrap();
      match stall_after {
        Some(n) => {
          stream.write_all(&body[..n]).unwrap();
          std::thread::sleep(Duration::from_secs(3));
        }
        None => stream.write_all(&body).unwrap(),
      }
    });
    format!("http://{addr}/app.apk")
  }

  fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lightread-update-test-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn names_are_plain_files() {
    assert_eq!(safe_name("LightRead_v1.14.0_android_arm64.apk"), Some("LightRead_v1.14.0_android_arm64.apk"));
    for bad in ["", "../x.apk", "a/b.apk", "a\\b.apk", ".hidden", "x.apk.part", "a:b", "a b.apk"] {
      assert_eq!(safe_name(bad), None, "{bad}");
    }
  }

  #[tokio::test]
  async fn downloads_and_hashes_then_promotes() {
    let body = b"installer-bytes".to_vec();
    let url = serve_once(body.clone(), body.len(), None);
    let dir = tmp_dir("ok");
    let part = dir.join("app.apk.part");
    let mut reports = Vec::new();
    let (sha, size) = fetch_to_file(&url, &part, Duration::from_secs(5), Duration::from_secs(5), None, None, |p| reports.push(p))
      .await
      .unwrap();
    assert_eq!(size, body.len() as u64);
    let expected: String = Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(sha, expected);
    assert_eq!(reports.last().unwrap().received, body.len() as u64);
    let path = finish_in(&dir, "app.apk", true).unwrap().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), body);
    assert!(!part.exists());
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[tokio::test]
  async fn rejected_download_is_deleted() {
    let dir = tmp_dir("reject");
    std::fs::write(dir.join("app.apk.part"), b"bad").unwrap();
    assert_eq!(finish_in(&dir, "app.apk", false).unwrap(), None);
    assert!(!dir.join("app.apk.part").exists());
    assert!(!dir.join("app.apk").exists());
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[tokio::test]
  async fn truncated_response_is_an_error() {
    let body = b"full-file-content".to_vec();
    let url = serve_once(body[..4].to_vec(), body.len(), None);
    let dir = tmp_dir("short");
    let err = fetch_to_file(&url, &dir.join("a.part"), Duration::from_secs(5), Duration::from_secs(5), None, None, |_| {})
      .await
      .unwrap_err();
    assert!(err.starts_with("network:"), "{err}");
    std::fs::remove_dir_all(&dir).unwrap();
  }

  /// 每 200 ms 发 16 字节, 共 160 字节
  fn serve_trickle() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut buf = [0u8; 1024];
      let _ = stream.read(&mut buf);
      let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 160\r\nConnection: close\r\n\r\n");
      for _ in 0..10 {
        if stream.write_all(&[1u8; 16]).is_err() {
          return;
        }
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(200));
      }
    });
    format!("http://{addr}/app.apk")
  }

  #[tokio::test]
  async fn slow_start_gives_up_but_patient_attempt_finishes() {
    let dir = tmp_dir("slow");
    let slow = MinRate { window: Duration::from_millis(500), bytes_per_sec: 10_000 };
    let err = fetch_to_file(&serve_trickle(), &dir.join("a.part"), Duration::from_secs(5), Duration::from_secs(5), Some(slow), None, |_| {})
      .await
      .unwrap_err();
    assert!(err.starts_with("slow:"), "{err}");
    let (_, size) = fetch_to_file(&serve_trickle(), &dir.join("b.part"), Duration::from_secs(5), Duration::from_secs(5), None, None, |_| {})
      .await
      .unwrap();
    assert_eq!(size, 160);
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[tokio::test]
  async fn stalled_download_times_out() {
    let body = vec![7u8; 64];
    let url = serve_once(body, 128, Some(16));
    let dir = tmp_dir("stall");
    let err = fetch_to_file(&url, &dir.join("a.part"), Duration::from_secs(5), Duration::from_millis(500), None, None, |_| {})
      .await
      .unwrap_err();
    assert!(err.starts_with("timeout:"), "{err}");
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
