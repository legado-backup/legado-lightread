//! 同步上传用的原生 HTTP 命令.
//!
//! `@tauri-apps/plugin-http` 的 JS 端把请求体转成数字数组再 JSON 序列化走 IPC,
//! 上传整本书 (几 MB 到几十 MB) 极慢且内存暴涨. 这里改为:
//!  - 书库里的文件 (`x-lr-file`): 由 Rust 直接从磁盘读取, 书的内容不经过 WebView;
//!  - 其他二进制 (封面等): 走 Tauri 2 的原始二进制 IPC (`InvokeBody::Raw`).
//!    Android 上 Tauri 只能走 postMessage, 原始体会变成 JSON 数字数组, 这里同样兼容.
//!
//! 请求元数据放在 IPC 请求头里, 值均经 `encodeURIComponent` 编码:
//!   x-lr-url      目标地址
//!   x-lr-method   方法 (默认 PUT)
//!   x-lr-headers  JSON 对象 { 头名: 值 }
//!   x-lr-proxy    代理地址 (http / https / socks5, 与 plugin-http 的 `proxy.all` 相同), 可省略
//!   x-lr-file     JSON { root, rel }: root 为书库根目录 (空 = 应用数据目录), rel 为 `books/<文件名>`
//!                 或 `covers/<文件名>`; 有此头时忽略请求体
//!
//! 错误字符串以 `timeout:` / `file:` / `network:` / `request:` 前缀区分, 供前端映射.

use std::{
  path::{Path, PathBuf},
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::InvokeBody, Manager};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// 响应正文只带回这么多字符 (WebDAV PUT 的正文无用, 留给报错)
const MAX_BODY_CHARS: usize = 2000;

#[derive(Debug, Serialize, PartialEq)]
pub struct UploadResult {
  pub status: u16,
  pub body: String,
}

#[derive(Debug, Deserialize)]
struct FileRef {
  #[serde(default)]
  root: String,
  rel: String,
}

#[derive(Debug, Clone)]
pub struct UploadSpec {
  pub url: String,
  pub method: String,
  pub headers: Vec<(String, String)>,
  pub proxy: Option<String>,
  pub no_redirect: bool,
}

/// 整体超时: 60 秒 + 每 MB 10 秒, 上限 30 分钟
pub fn upload_timeout(len: u64) -> Duration {
  const MB: u64 = 1024 * 1024;
  let secs = 60 + len.div_ceil(MB) * 10;
  Duration::from_secs(secs.min(30 * 60))
}

fn pct_decode(s: &str) -> Result<String, String> {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' {
      let hex = bytes
        .get(i + 1..i + 3)
        .and_then(|h| std::str::from_utf8(h).ok())
        .and_then(|h| u8::from_str_radix(h, 16).ok())
        .ok_or_else(|| "request: 非法的百分号编码".to_string())?;
      out.push(hex);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).map_err(|_| "request: 非 UTF-8 的请求头".to_string())
}

fn header(map: &tauri::http::HeaderMap, name: &str) -> Result<Option<String>, String> {
  match map.get(name) {
    None => Ok(None),
    Some(v) => {
      let raw = v.to_str().map_err(|_| format!("request: 请求头 {name} 非 ASCII"))?;
      pct_decode(raw).map(Some)
    }
  }
}

/// 原始 IPC 体; Android 的 postMessage 通道上它是 JSON 数字数组
fn body_bytes(body: &InvokeBody) -> Result<Vec<u8>, String> {
  match body {
    InvokeBody::Raw(bytes) => Ok(bytes.clone()),
    InvokeBody::Json(serde_json::Value::Null) => Ok(Vec::new()),
    InvokeBody::Json(serde_json::Value::Array(items)) => items
      .iter()
      .map(|v| {
        v.as_u64()
          .filter(|n| *n <= 255)
          .map(|n| n as u8)
          .ok_or_else(|| "request: 请求体不是字节数组".to_string())
      })
      .collect(),
    InvokeBody::Json(_) => Err("request: 请求体不是字节数组".into()),
  }
}

/// `books/<name>` 或 `covers/<name>`; name 不含路径分隔符、冒号, 也不是 `.` / `..`
fn safe_rel(rel: &str) -> Option<PathBuf> {
  let (dir, name) = rel.split_once('/')?;
  if !matches!(dir, "books" | "covers") || name.is_empty() || name == "." || name == ".." {
    return None;
  }
  if name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0')) {
    return None;
  }
  Some(Path::new(dir).join(name))
}

/// 书库文件的绝对路径. 自定义根目录必须是绝对路径且是轻阅书库 (含 lightread.db),
/// 避免这个命令被当成任意文件读取 + 外发的通道.
fn resolve_library_file(app_data: Option<PathBuf>, file: &FileRef) -> Result<PathBuf, String> {
  let rel = safe_rel(&file.rel).ok_or_else(|| format!("file: 不允许的路径 {}", file.rel))?;
  let root = file.root.trim_end_matches(['/', '\\']);
  let base = if root.is_empty() {
    app_data.ok_or_else(|| "file: 无法定位应用数据目录".to_string())?
  } else {
    let p = PathBuf::from(root);
    if !p.is_absolute() || !p.join("lightread.db").is_file() {
      return Err(format!("file: 不是轻阅书库目录 {root}"));
    }
    p
  };
  Ok(base.join(rel))
}

fn build_client(spec: &UploadSpec, timeout: Duration) -> Result<reqwest::Client, String> {
  let mut builder = reqwest::Client::builder()
    .connect_timeout(CONNECT_TIMEOUT)
    .timeout(timeout);
  if spec.no_redirect {
    builder = builder.redirect(reqwest::redirect::Policy::none());
  }
  if let Some(proxy) = spec.proxy.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
    let proxy = reqwest::Proxy::all(proxy).map_err(|e| format!("request: 代理地址无效: {e}"))?;
    builder = builder.proxy(proxy);
  }
  builder.build().map_err(|e| format!("request: {e}"))
}

/// 发出请求 (与 Tauri 无关, 便于单测)
pub async fn send(spec: UploadSpec, body: Vec<u8>, timeout: Duration) -> Result<UploadResult, String> {
  let method = reqwest::Method::from_bytes(spec.method.as_bytes())
    .map_err(|_| format!("request: 非法的方法 {}", spec.method))?;
  let client = build_client(&spec, timeout)?;
  let mut req = client.request(method, &spec.url);
  for (name, value) in &spec.headers {
    let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
      .map_err(|_| format!("request: 非法的请求头 {name}"))?;
    let value = reqwest::header::HeaderValue::from_str(value)
      .map_err(|_| format!("request: 请求头 {name} 的值非法"))?;
    req = req.header(name, value);
  }
  let res = req.body(body).send().await.map_err(map_err)?;
  let status = res.status().as_u16();
  let text = res.text().await.unwrap_or_default();
  let body = text.chars().take(MAX_BODY_CHARS).collect();
  Ok(UploadResult { status, body })
}

fn map_err(e: reqwest::Error) -> String {
  if e.is_timeout() {
    format!("timeout: {e}")
  } else {
    // 带上底层原因 (DNS / TLS / 连接被拒等), 便于排查
    let mut msg = format!("network: {e}");
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
      msg.push_str(&format!(": {s}"));
      source = s.source();
    }
    msg
  }
}

fn parse_spec(map: &tauri::http::HeaderMap) -> Result<(UploadSpec, Option<FileRef>), String> {
  let url = header(map, "x-lr-url")?.ok_or("request: 缺少 x-lr-url")?;
  let method = header(map, "x-lr-method")?.unwrap_or_else(|| "PUT".into());
  let headers = match header(map, "x-lr-headers")? {
    None => Vec::new(),
    Some(json) => {
      let obj: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&json).map_err(|e| format!("request: x-lr-headers: {e}"))?;
      obj.into_iter().collect()
    }
  };
  let proxy = header(map, "x-lr-proxy")?;
  let no_redirect = header(map, "x-lr-no-redirect")?.as_deref() == Some("true");
  let file = match header(map, "x-lr-file")? {
    None => None,
    Some(json) => Some(serde_json::from_str::<FileRef>(&json).map_err(|e| format!("request: x-lr-file: {e}"))?),
  };
  Ok((UploadSpec { url, method, headers, proxy, no_redirect }, file))
}

#[tauri::command]
pub async fn http_upload(
  app: tauri::AppHandle,
  request: tauri::ipc::Request<'_>,
) -> Result<UploadResult, String> {
  let (spec, file) = parse_spec(request.headers())?;
  let body = match file {
    Some(file) => {
      let path = resolve_library_file(app.path().app_data_dir().ok(), &file)?;
      tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| format!("file: {e}"))?
        .map_err(|e| format!("file: 读取 {} 失败: {e}", file.rel))?
    }
    None => body_bytes(request.body())?,
  };
  let timeout = upload_timeout(body.len() as u64);
  send(spec, body, timeout).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Read, Write};
  use std::net::TcpListener;
  use std::sync::mpsc;

  /// 最小 HTTP 服务器: 收一个请求, 把原始请求 (头 + 体) 发回测试线程, 按 respond 决定是否回应
  fn serve_once(respond: bool) -> (String, mpsc::Receiver<(String, Vec<u8>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut buf = Vec::new();
      let mut chunk = [0u8; 8192];
      let (head, body_start) = loop {
        let n = stream.read(&mut chunk).unwrap();
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
          break (String::from_utf8_lossy(&buf[..i]).to_string(), i + 4);
        }
      };
      let len: usize = head
        .lines()
        .find_map(|l| {
          let (k, v) = l.split_once(':')?;
          k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok())?
        })
        .unwrap_or(0);
      let mut body = buf[body_start..].to_vec();
      while body.len() < len {
        let n = stream.read(&mut chunk).unwrap();
        if n == 0 {
          break;
        }
        body.extend_from_slice(&chunk[..n]);
      }
      tx.send((head, body)).unwrap();
      if respond {
        let _ = stream.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      } else {
        std::thread::sleep(Duration::from_secs(5));
      }
    });
    (format!("http://{addr}"), rx)
  }

  fn spec(url: String) -> UploadSpec {
    UploadSpec {
      url,
      method: "PUT".into(),
      headers: vec![
        ("content-type".into(), "application/octet-stream".into()),
        ("authorization".into(), "Basic dTpw".into()),
      ],
      proxy: None,
      no_redirect: false,
    }
  }

  #[tokio::test]
  async fn sends_method_headers_and_binary_body() {
    let (base, rx) = serve_once(true);
    let body: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
    let res = send(spec(format!("{base}/dav/files/abc")), body.clone(), Duration::from_secs(10))
      .await
      .unwrap();
    assert_eq!(res, UploadResult { status: 201, body: "ok".into() });
    let (head, got) = rx.recv().unwrap();
    assert!(head.starts_with("PUT /dav/files/abc HTTP/1.1"), "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("authorization: basic dtpw"), "{head}");
    assert!(lower.contains("content-type: application/octet-stream"), "{head}");
    assert!(lower.contains("content-length: 300000"), "{head}");
    assert_eq!(got, body);
  }

  #[tokio::test]
  async fn private_upload_does_not_follow_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut input = [0u8; 8192];
      let _ = stream.read(&mut input);
      stream.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let mut request = spec(format!("http://{address}/api/upload"));
    request.method = "POST".into();
    request.no_redirect = true;
    let result = send(request, b"private book".to_vec(), Duration::from_secs(2)).await.unwrap();
    assert_eq!(result.status, 307);
  }

  #[tokio::test]
  async fn times_out_when_server_hangs() {
    let (base, _rx) = serve_once(false);
    let err = send(spec(format!("{base}/x")), b"data".to_vec(), Duration::from_millis(500))
      .await
      .unwrap_err();
    assert!(err.starts_with("timeout:"), "{err}");
  }

  #[tokio::test]
  async fn reports_connection_errors_and_bad_input() {
    // 先占一个端口再释放, 大概率没人监听
    let addr = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let err = send(spec(format!("http://{addr}/x")), vec![], Duration::from_secs(5)).await.unwrap_err();
    assert!(err.starts_with("network:"), "{err}");
    let mut bad = spec("http://127.0.0.1:1/x".into());
    bad.method = "BAD METHOD".into();
    assert!(send(bad, vec![], Duration::from_secs(1)).await.unwrap_err().starts_with("request:"));
    let mut bad = spec("http://127.0.0.1:1/x".into());
    bad.proxy = Some("::not a url::".into());
    assert!(send(bad, vec![], Duration::from_secs(1)).await.unwrap_err().starts_with("request:"));
  }

  #[test]
  fn timeout_scales_with_size_and_caps() {
    assert_eq!(upload_timeout(0), Duration::from_secs(60));
    assert_eq!(upload_timeout(1), Duration::from_secs(70));
    assert_eq!(upload_timeout(20 * 1024 * 1024), Duration::from_secs(260));
    assert_eq!(upload_timeout(10 * 1024 * 1024 * 1024), Duration::from_secs(1800));
  }

  #[test]
  fn parses_encoded_request_headers() {
    let mut map = tauri::http::HeaderMap::new();
    let enc = |s: &str| -> String {
      s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
    };
    map.insert("x-lr-url", enc("https://dav.example.com/书/a b").parse().unwrap());
    map.insert("x-lr-headers", enc(r#"{"content-type":"image/jpeg"}"#).parse().unwrap());
    map.insert("x-lr-proxy", enc("socks5://127.0.0.1:1080").parse().unwrap());
    map.insert("x-lr-file", enc(r#"{"root":"","rel":"books/x.epub"}"#).parse().unwrap());
    let (spec, file) = parse_spec(&map).unwrap();
    assert_eq!(spec.url, "https://dav.example.com/书/a b");
    assert_eq!(spec.method, "PUT");
    assert_eq!(spec.headers, vec![("content-type".to_string(), "image/jpeg".to_string())]);
    assert_eq!(spec.proxy.as_deref(), Some("socks5://127.0.0.1:1080"));
    assert!(!spec.no_redirect);
    let file = file.unwrap();
    assert_eq!((file.root.as_str(), file.rel.as_str()), ("", "books/x.epub"));
    assert!(parse_spec(&tauri::http::HeaderMap::new()).is_err());
    map.insert("x-lr-no-redirect", "true".parse().unwrap());
    assert!(parse_spec(&map).unwrap().0.no_redirect);
  }

  #[test]
  fn accepts_raw_and_json_array_bodies() {
    assert_eq!(body_bytes(&InvokeBody::Raw(vec![1, 2, 255])).unwrap(), vec![1, 2, 255]);
    assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!([0, 7, 255]))).unwrap(), vec![0, 7, 255]);
    assert_eq!(body_bytes(&InvokeBody::Json(serde_json::Value::Null)).unwrap(), Vec::<u8>::new());
    assert!(body_bytes(&InvokeBody::Json(serde_json::json!([256]))).is_err());
    assert!(body_bytes(&InvokeBody::Json(serde_json::json!({"a": 1}))).is_err());
  }

  #[test]
  fn library_paths_are_confined() {
    let data = std::env::temp_dir().join(format!("lr-upload-test-{}", std::process::id()));
    let file = |root: &str, rel: &str| FileRef { root: root.into(), rel: rel.into() };
    assert_eq!(
      resolve_library_file(Some(data.clone()), &file("", "books/abc.epub")).unwrap(),
      data.join("books").join("abc.epub"),
    );
    assert!(resolve_library_file(Some(data.clone()), &file("", "covers/abc.jpg")).is_ok());
    for rel in ["../etc/passwd", "books/../x", "books/a/b", "books/..", "other/x", "books/", "books/c:x", "books\\x"] {
      let err = resolve_library_file(Some(data.clone()), &file("", rel)).unwrap_err();
      assert!(err.starts_with("file:"), "{rel}: {err}");
    }
    // 自定义根目录: 必须是绝对路径且含 lightread.db
    std::fs::create_dir_all(&data).unwrap();
    let root = data.to_string_lossy().to_string();
    assert!(resolve_library_file(None, &file(&root, "books/a.pdf")).is_err());
    std::fs::write(data.join("lightread.db"), b"").unwrap();
    assert_eq!(
      resolve_library_file(None, &file(&format!("{root}/"), "books/a.pdf")).unwrap(),
      data.join("books").join("a.pdf"),
    );
    assert!(resolve_library_file(None, &file("relative/dir", "books/a.pdf")).is_err());
    let _ = std::fs::remove_dir_all(&data);
  }
}
