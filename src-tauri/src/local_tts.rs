//! 本地离线神经语音: sherpa-onnx + Kokoro multi-lang v1.1 (中英, 103 音色).
//! 模型 (~310MB) 由应用内下载到数据目录, 合成完全离线.
//! 移动端暂不支持 (sherpa-onnx 交叉编译限制), 命令返回明确错误.

#[cfg(any(target_os = "android", target_os = "ios"))]
mod stub {
    use serde::Serialize;
    use tauri::AppHandle;

    #[derive(Serialize)]
    pub struct LocalTtsStatus {
        pub installed: bool,
        pub path: String,
    }

    #[tauri::command]
    pub fn local_tts_status(_app: AppHandle) -> Result<LocalTtsStatus, String> {
        Ok(LocalTtsStatus { installed: false, path: String::new() })
    }

    #[tauri::command]
    pub async fn local_tts_download(_app: AppHandle, _proxy: Option<String>) -> Result<(), String> {
        Err("移动端暂不支持离线语音包".into())
    }

    #[tauri::command]
    pub fn local_tts_remove(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn local_tts_warmup(_app: AppHandle, _sid: Option<i32>) -> Result<(), String> {
        Err("移动端暂不支持离线语音".into())
    }

    #[tauri::command]
    pub fn local_tts_synthesize(
        _app: AppHandle,
        _text: String,
        _sid: i32,
        _speed: f32,
    ) -> Result<tauri::ipc::Response, String> {
        Err("移动端暂不支持离线语音".into())
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub use stub::*;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
use serde::Serialize;
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig,
};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const MODEL_DIR: &str = "tts-models/kokoro-multi-lang-v1_1";
const MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2";

/// 已加载的引擎及其文本规整配置; 规整配置变化 (切换中/英文音色) 时才重建。
struct LoadedEngine {
    tts: OfflineTts,
    rule_fsts: Option<String>,
}

static ENGINE: OnceLock<Mutex<Option<LoadedEngine>>> = OnceLock::new();

fn model_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(dir.join(MODEL_DIR))
}

fn model_ready(root: &PathBuf) -> bool {
    root.join("model.onnx").exists()
        && root.join("voices.bin").exists()
        && root.join("tokens.txt").exists()
}

#[derive(Serialize)]
pub struct LocalTtsStatus {
    pub installed: bool,
    pub path: String,
}

#[tauri::command]
pub fn local_tts_status(app: AppHandle) -> Result<LocalTtsStatus, String> {
    let root = model_root(&app)?;
    Ok(LocalTtsStatus {
        installed: model_ready(&root),
        path: root.to_string_lossy().to_string(),
    })
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    phase: String,
}

/// 下载并解压模型包; 进度经 `local-tts-progress` 事件推送
#[tauri::command]
pub async fn local_tts_download(app: AppHandle, proxy: Option<String>) -> Result<(), String> {
    let root = model_root(&app)?;
    if model_ready(&root) {
        return Ok(());
    }
    let parent = root
        .parent()
        .ok_or("路径异常")?
        .to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| format!("创建目录失败: {e}"))?;

    let emit = {
        let app = app.clone();
        move |downloaded: u64, total: u64, phase: &str| {
            let _ = app.emit(
                "local-tts-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    phase: phase.into(),
                },
            );
        }
    };

    // 下载 (blocking IO 放独立线程)
    let archive_path = parent.join("kokoro-download.tar.bz2");
    let archive = archive_path.clone();
    let proxy_url = proxy.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut agent_builder = ureq::AgentBuilder::new();
        if !proxy_url.is_empty() {
            let p = ureq::Proxy::new(&proxy_url).map_err(|e| format!("代理无效: {e}"))?;
            agent_builder = agent_builder.proxy(p);
        }
        let agent = agent_builder.build();
        let resp = agent
            .get(MODEL_URL)
            .call()
            .map_err(|e| format!("下载失败: {e}"))?;
        let total: u64 = resp
            .header("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut reader = resp.into_reader();
        let mut file =
            std::fs::File::create(&archive).map_err(|e| format!("写入失败: {e}"))?;
        let mut buf = [0u8; 256 * 1024];
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        loop {
            let n = std::io::Read::read(&mut reader, &mut buf)
                .map_err(|e| format!("下载中断: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("写入失败: {e}"))?;
            downloaded += n as u64;
            if last_emit.elapsed().as_millis() > 200 {
                emit(downloaded, total, "downloading");
                last_emit = std::time::Instant::now();
            }
        }
        emit(downloaded, total, "extracting");

        // 解压 (tar.bz2), 顶层目录即 kokoro-multi-lang-v1_1
        let file = std::fs::File::open(&archive).map_err(|e| format!("读取包失败: {e}"))?;
        let bz = bzip2::read::BzDecoder::new(file);
        let mut tar = tar::Archive::new(bz);
        tar.unpack(&parent).map_err(|e| format!("解压失败: {e}"))?;
        let _ = std::fs::remove_file(&archive);
        emit(downloaded, total, "done");
        Ok(())
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;

    let root = model_root(&app)?;
    if !model_ready(&root) {
        return Err("解压后未找到模型文件".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn local_tts_remove(app: AppHandle) -> Result<(), String> {
    let root = model_root(&app)?;
    run_engine_task(move || {
        // 等待合成、释放模型和删除文件都不能占用 UI 线程。
        // 删除完成前持有同一把锁，避免新的合成重新打开模型。
        let lock = ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = lock.lock().map_err(|_| "语音引擎锁已损坏")?;
        *guard = None;
        std::fs::remove_dir_all(&root).map_err(|e| format!("删除失败: {e}"))
    })
    .await
}

/// 中文文本规整规则 (电话号码 / 日期 / 数字 → 汉字读法), 按此顺序从左到右应用。
/// 与 sherpa-onnx 官方 TTS APK 给 kokoro-multi-lang-v1_1 的配置一致
/// (scripts/apk/generate-tts-apk-script.py); 模型包里自带这三个文件。
const ZH_RULE_FSTS: [&str; 3] = ["phone-zh.fst", "date-zh.fst", "number-zh.fst"];

/// sid 0–2 是英文音色 (af_maple / af_sol / bf_vale), 3–102 是中文音色
/// (见 sherpa 文档 kokoro-multi-lang-v1_1 的 sid 表, 前端目录 src/services/kokoroVoices.ts)。
const FIRST_ZH_SID: i32 = 3;

/// 前端未传 sid 时 (旧版 warmup 调用) 按默认中文音色预加载, 与 DEFAULT_KOKORO_SID 一致。
const DEFAULT_SID: i32 = 50;

/// sherpa-onnx 把规则 FST 应用到整段文本 (csrc/offline-tts-kokoro-impl.h), 英文句子里的
/// 数字也会被改写成汉字 ("Chapter 12" → "Chapter 十二"), 所以只给中文音色启用。
fn rule_fsts_for(root: &Path, sid: i32) -> Option<String> {
    if sid >= FIRST_ZH_SID {
        existing_rule_fsts(root)
    } else {
        None
    }
}

/// 只拼接模型目录里真实存在的规则 FST, 用逗号分隔 (sherpa-onnx 的 `rule_fsts` 格式)。
/// sherpa-onnx 校验配置时任何一个 FST 缺失都会让引擎初始化失败, 所以旧版/残缺的
/// 安装要跳过缺失的文件, 全部缺失时返回 None (等同于不做规整, 即之前的行为)。
/// 路径里带逗号会被 sherpa 误拆, 这种文件同样跳过。
fn existing_rule_fsts(root: &Path) -> Option<String> {
    let found: Vec<String> = ZH_RULE_FSTS
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.contains(','))
        .collect();
    if found.is_empty() {
        None
    } else {
        Some(found.join(","))
    }
}

fn build_engine(root: &PathBuf, rule_fsts: Option<String>) -> Result<OfflineTts, String> {
    let p = |name: &str| Some(root.join(name).to_string_lossy().to_string());
    let lexicon = format!(
        "{},{}",
        root.join("lexicon-us-en.txt").to_string_lossy(),
        root.join("lexicon-zh.txt").to_string_lossy()
    );
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: p("model.onnx"),
                voices: p("voices.bin"),
                tokens: p("tokens.txt"),
                data_dir: p("espeak-ng-data"),
                // sherpa-onnx >= 1.12.15 已内置 jieba 词典, Kokoro 的 dict_dir 被忽略,
                // 传了只会在每次加载时打一条错误日志 (csrc/offline-tts-kokoro-model-config.cc)。
                dict_dir: None,
                lexicon: Some(lexicon),
                lang: None,
                length_scale: 1.0,
            },
            num_threads: inference_threads(),
            ..Default::default()
        },
        rule_fsts,
        ..Default::default()
    };
    OfflineTts::create(&config).ok_or_else(|| "初始化语音引擎失败 (模型文件可能损坏)".to_string())
}

/// 推理线程数: 用一半逻辑核 (1–4)。2 核的低配 Windows 机器上占满全部核心
/// 会让 WebView 渲染进程抢不到 CPU, 表现为朗读时窗口「无响应」。
fn inference_threads() -> i32 {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores / 2).clamp(1, 4) as i32
}

/// 在引擎锁内取得 (必要时加载) 模型并执行 `f`; 模型只加载一次, 之后每段复用。
/// 只有在中文/英文音色之间切换导致规整配置变化时才重新加载 (先释放旧模型再加载)。
fn with_engine<T>(
    root: &PathBuf,
    sid: i32,
    f: impl FnOnce(&OfflineTts) -> Result<T, String>,
) -> Result<T, String> {
    let lock = ENGINE.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|_| "语音引擎锁已损坏")?;
    if !model_ready(root) {
        return Err("离线语音包未安装".into());
    }
    let rule_fsts = rule_fsts_for(root, sid);
    if guard.as_ref().map_or(true, |loaded| loaded.rule_fsts != rule_fsts) {
        *guard = None;
        let tts = build_engine(root, rule_fsts.clone())?;
        *guard = Some(LoadedEngine { tts, rule_fsts });
    }
    f(&guard.as_ref().unwrap().tts)
}

/// f32 采样 → 16-bit PCM WAV
fn to_wav(samples: &[f32], sample_rate: i32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + samples.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    wav.extend_from_slice(&(sample_rate as u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        wav.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    wav
}

fn synthesize_at(root: &PathBuf, text: &str, sid: i32, speed: f32) -> Result<Vec<u8>, String> {
    with_engine(root, sid, |engine| {
        let audio = engine
            .generate_with_config(
                text,
                &GenerationConfig {
                    sid,
                    speed,
                    ..Default::default()
                },
                None::<fn(&[f32], f32) -> bool>,
            )
            .ok_or("合成失败")?;
        Ok(to_wav(audio.samples(), audio.sample_rate()))
    })
}

/// 模型加载、推理及锁等待必须在 blocking pool 执行；async 命令本身不会转移 CPU 工作。
async fn run_engine_task<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("离线语音任务失败: {e}"))?
}

/// 预加载模型 (首次约 10–20s), 让前端在开始朗读前就能提示「正在加载」并提前完成加载。
/// `sid` 可选: 传入将要使用的音色可避免英文音色首段再按另一套规整配置重载一次。
#[tauri::command]
pub async fn local_tts_warmup(app: AppHandle, sid: Option<i32>) -> Result<(), String> {
    let root = model_root(&app)?;
    let sid = sid.unwrap_or(DEFAULT_SID);
    run_engine_task(move || with_engine(&root, sid, |_| Ok(()))).await
}

/// 合成一段文本，返回 wav 字节流；Tauri 同步命令会阻塞窗口的 IPC 调用线程。
#[tauri::command]
pub async fn local_tts_synthesize(
    app: AppHandle,
    text: String,
    sid: i32,
    speed: f32,
) -> Result<tauri::ipc::Response, String> {
    let root = model_root(&app)?;
    let wav = run_engine_task(move || synthesize_at(&root, &text, sid, speed)).await?;
    Ok(tauri::ipc::Response::new(wav))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_task_runs_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(run_engine_task(|| {
            Ok(std::thread::current().id())
        }))
        .expect("worker should succeed");
        assert_ne!(caller, worker, "model work must not run on the IPC caller");
    }

    #[test]
    fn engine_task_preserves_errors_and_catches_worker_panics() {
        let result = tauri::async_runtime::block_on(run_engine_task(|| {
            Err::<(), _>("离线语音包未安装".to_string())
        }));
        assert_eq!(result.unwrap_err(), "离线语音包未安装");
        let result = tauri::async_runtime::block_on(run_engine_task(|| -> Result<(), String> {
            panic!("simulated inference failure");
        }));
        assert!(result.unwrap_err().starts_with("离线语音任务失败:"));
    }

    #[test]
    fn inference_leaves_cores_for_the_ui() {
        let n = inference_threads();
        assert!((1..=4).contains(&n));
        if let Ok(cores) = std::thread::available_parallelism() {
            assert!(n as usize <= cores.get().max(1));
        }
    }

    #[test]
    fn rule_fsts_only_list_files_that_exist() {
        let root = std::env::temp_dir().join(format!("lightread-rule-fsts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 旧版/残缺安装: 一个都没有 → 不设置, 引擎照旧初始化
        assert_eq!(existing_rule_fsts(&root), None);

        std::fs::write(root.join("number-zh.fst"), b"").unwrap();
        std::fs::write(root.join("phone-zh.fst"), b"").unwrap();
        // 同名目录不算文件
        std::fs::create_dir_all(root.join("date-zh.fst")).unwrap();
        let expected = format!(
            "{},{}",
            root.join("phone-zh.fst").to_string_lossy(),
            root.join("number-zh.fst").to_string_lossy()
        );
        assert_eq!(existing_rule_fsts(&root).as_deref(), Some(expected.as_str()));

        std::fs::remove_dir_all(root.join("date-zh.fst")).unwrap();
        std::fs::write(root.join("date-zh.fst"), b"").unwrap();
        let all = existing_rule_fsts(&root).unwrap();
        let names: Vec<_> = all
            .split(',')
            .map(|f| Path::new(f).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["phone-zh.fst", "date-zh.fst", "number-zh.fst"]);
        // 英文音色不做中文规整, 中文音色才带上 FST
        assert_eq!(rule_fsts_for(&root, 0), None);
        assert_eq!(rule_fsts_for(&root, 2), None);
        assert_eq!(rule_fsts_for(&root, 3).as_deref(), Some(all.as_str()));
        assert_eq!(rule_fsts_for(&root, DEFAULT_SID).as_deref(), Some(all.as_str()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn warmup_without_model_reports_not_installed() {
        let root = std::env::temp_dir().join("lightread-no-kokoro-model");
        let err = with_engine(&root, DEFAULT_SID, |_| Ok(())).unwrap_err();
        assert_eq!(err, "离线语音包未安装");
    }

    #[test]
    fn synthesizes_with_downloaded_model() {
        let Ok(root) = std::env::var("KOKORO_MODEL_DIR") else {
            eprintln!("跳过: 未设置 KOKORO_MODEL_DIR");
            return;
        };
        let root = PathBuf::from(root);
        // 可用 KOKORO_TEST_TEXT / KOKORO_TEST_SID 换文本和音色做试听
        let text = std::env::var("KOKORO_TEST_TEXT").unwrap_or_else(|_| {
            "夜色像一块浸了水的墨布，慢慢压下来。2026年10月4日，电话13800138000，圆周率约3.14。".into()
        });
        let sid = std::env::var("KOKORO_TEST_SID")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_SID);
        let wav = synthesize_at(&root, &text, sid, 1.0).expect("synthesis should succeed");
        assert!(wav.len() > 40_000, "audio too small: {}", wav.len());
        assert_eq!(&wav[..4], b"RIFF");
        std::fs::write("/tmp/kokoro-test.wav", &wav).ok();
    }
}
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop::*;
