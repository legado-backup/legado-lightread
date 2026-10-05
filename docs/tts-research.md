# 听书 TTS 方案调研（2026-10-04）

> 范围：给「听书」找更好的**本地离线、中文友好**的语音合成方案，并与在线方案对比。
> 现状：Edge 在线神经语音（`src-tauri/src/edge_tts.rs`）+ 系统 speechSynthesis + 桌面离线 sherpa-onnx 1.13.3 + Kokoro multi-lang v1.1（`src-tauri/src/local_tts.rs`，约 310–347MB，103 个音色，Android/iOS 编译为 stub）。
> 说明：数据来自官方仓库、模型卡、sherpa-onnx 发布页和 `gh` 查询。标 **〔未核实〕** 的是二手资料或社区数字，没有在本机验证。本次没有下载模型，也没有实测。

---

## 1. 结论与推荐

1. **桌面主力继续用 sherpa-onnx + Kokoro v1.1-zh，暂不换。** 在「中文质量 / 体积 / CPU 实时 / 许可 / 现成 Rust 运行时」这几项上，目前没有哪个方案能全面超过它。Kokoro 是 Apache-2.0 许可，有 100 个中文音色（55 女 45 男）。sherpa-onnx 直接支持 Kokoro，不用另写推理代码。2025–2026 年中文质量明显更好的模型（CosyVoice 3、IndexTTS-2.5、VoxCPM2、Qwen3-TTS、Fish S2、OmniVoice）都在 0.5B–4B 参数量级，普通笔记本 CPU 上大多跑不到实时，有几个许可还不能商用。
2. **先做几项低成本改进，收益最大：**
   - **补上 `rule_fsts`。** sherpa-onnx 官方 APK 配置给 Kokoro multi-lang 传了 `phone-zh.fst,date-zh.fst,number-zh.fst`（[generate-tts-apk-script.py](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/apk/generate-tts-apk-script.py) 第 585 行），用来朗读数字、日期和电话号码。LightRead 的 `build_engine()` 没有设置这一项。改动只有一行，书里年份、数字的读法会明显改善。要先确认 v1_1 压缩包里有这三个文件。
   - **升级到 sherpa-onnx 1.13.8**（2026-09-11）。新版带 onnxruntime 1.28.2，Rust 支持 Windows arm64，校验 Kokoro 的 voices 文件，并修复了异步 TTS 回调的 use-after-free（[CHANGELOG](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md)）。
   - **提供 int8 精简包作为可选项。** `kokoro-int8-multi-lang-v1_1` 是 140MB（fp32 版 347MB），适合低配 Windows（GitHub #8）和以后的手机端。但有报告说 int8 Kokoro 会有高频音调伪影，在部分 CPU 上反而比 fp32 慢（[YAAH #298](https://github.com/elboaf/YAAH/issues/298)），所以先 A/B 试听，不要直接换掉默认包。
3. **Android 离线听书现在可以做了，这是本次最重要的发现。** sherpa-onnx 1.13.5 给 `sherpa-onnx-sys` 加了 Android 共享链接（#3739）。1.13.7 发布了官方 Tauri 示例，Linux/macOS/Windows/**Android arm64 APK**/iOS 都能跑（[tauri release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tauri)，[示例源码](https://github.com/k2-fsa/sherpa-onnx/tree/master/tauri-examples/hello_world)）：`build.rs` 自动下载 `.so` 放进 `jniLibs`，`cargo tauri android build --target aarch64` 就能出包。`local_tts.rs` 里写的「sherpa-onnx 无移动端预编译库」已经过时。建议在 K70 / K30 Pro 上先做 PoC，依次测 Kokoro int8 → Piper zh_CN（13MB int8）→ Matcha zh-en。
4. **第二梯队（桌面实验，「高品质 / 克隆」可选包）：**
   - **MOSS-TTS-Nano**（OpenMOSS，2026-04）：参数约 0.1B，Apache-2.0，支持中文在内 20 种语言。有官方 ONNX CPU 版，支持流式，4 核 CPU 能实时（官方说法），自带音色并支持克隆，还有官方 Android ORT 示例和「Reader」浏览器插件。它是目前最像「下一代 Kokoro」的候选。缺点是不在 sherpa-onnx 里，要用 Rust `ort` crate 自己写自回归推理和音频 tokenizer 解码，工作量中等。
   - **Qwen3-TTS-0.6B**（Apache-2.0）：中文质量好，有 9 个预置音色（中文 5 个，含京味、川味），支持克隆。CPU 上 int4 量化后 RTF 约 0.5（M1），GGUF 方案 RTF 约 1.3〔未核实〕。只适合高配机器，暂缓。
   - **OmniVoice**（k2-fsa 自家，0.6B）：sherpa-onnx 的接入 issue 还开着（[#3651](https://github.com/k2-fsa/sherpa-onnx/issues/3651)）。接入后改动成本最低，值得持续关注。
5. **不建议采用：** F5-TTS、MaskGCT、Spark-TTS 的权重是 NC（非商用）许可；Fish S2 是研究许可，模型 4.4B；ChatTTS 是 AGPL 加 NC。Kyutai TTS、Pocket TTS、KittenTTS、Supertonic 3、Dia、VibeVoice-Realtime 都**不支持中文**。CosyVoice 3、IndexTTS-2.5、VoxCPM2、MOSS-TTS 大模型、Step-Audio-EditX 需要 GPU，不适合阅读器内置。
6. **在线：** Edge 继续作为默认在线引擎，免费，中文音色多。可以考虑加一个「自带 API Key」的云引擎（豆包 Seed-TTS 2.0 / MiniMax Speech 2.8 / 阿里百炼 CosyVoice、Qwen-TTS），给想要顶级音质的用户用，作为 Edge 接口失效时的备选。

---

## 2. 对比表（本地 / 离线候选）

| 方案 | 中文质量 | 中文音色 | 体积 | CPU 速度 | 手机 arm64 | 流式 | 许可 | 运行时 | 克隆 |
|---|---|---|---|---|---|---|---|---|---|
| **Kokoro v1.1-zh**（现用） | 中上，自然；多音字靠词典+jieba，偶有误读；可中英混读 | 100（55F/45M）+3 英文 | 347MB / int8 140MB | 桌面远快于实时〔未在本机测〕；Pi4 上 v1.0 4 线程 RTF 3.2 | 可行（sherpa 有 Android TTS Engine APK）；高端机约实时〔未核实〕 | 句级（回调） | Apache-2.0 | **sherpa-onnx ✅** | 否 |
| **Piper zh_CN chaowen / xiao_ya**（2026-04 新增） | 中等，VITS 偏机械；拼音 + G2PW 词典，多音字处理有改进 | 2（男/女）+ huayan | int8 13MB / fp16 27MB / 57MB | 极快 | **很适合** | 句级 | 来自 rhasspy piper-voices，单个音色的许可需核实〔未核实〕 | sherpa-onnx ✅ | 否 |
| **Matcha zh-en / zh-baker** | 中等，单人；zh-en 只有 16kHz | 1 | 72MB + vocoder 51MB | Pi4 4 线程 RTF 0.39 | 很适合 | 句级 | baker **非商用**；zh-en 数据来源未核实 | sherpa-onnx ✅ | 否 |
| MeloTTS zh_en（vits-melo） | 中等 | 1 | 159MB | 快 | 可行 | 句级 | MIT | sherpa-onnx ✅ | 否 |
| **ZipVoice distill zh-en** | 好（零样本） | 只能克隆（需参考音频+逐字文本） | int8 104MB / fp32 455MB | 多步 flow matching，比 Kokoro 慢〔未核实〕 | 勉强 | 否 | 代码 Apache；Emilia 数据，权重许可需核实 | sherpa-onnx ✅ | 是 |
| **MOSS-TTS-Nano** | 好（官方说法）〔未实测〕 | 内置若干 + 克隆 | 0.1B；ONNX 仓库 641MB + tokenizer 86MB（可能含多种精度） | 4 核流式实时；M4 单核流畅（官方） | 有官方 Android ORT 示例 | **是** | Apache-2.0 | ONNX Runtime（不在 sherpa 里） | 是 |
| Qwen3-TTS 0.6B | 很好，有方言音色 | 9 预置（中文 5）+ 克隆 | 约 2.4GB（bf16） | M1 int4 RTF 0.52；GGUF CPU 约 1.3〔未核实〕 | 否 | 是（GPU 首包 97ms） | Apache-2.0 | PyTorch / GGUF / 纯 C 移植 | 是 |
| OmniVoice | 很好（主打克隆） | 克隆 / 音色设计 | 0.6B，3.1GB | GPU RTF 0.025；社区 ONNX CPU 约 0.5–0.6〔未核实〕 | 否 | 否（NAR 32 步） | 代码 Apache；权重未标注 | PyTorch；sherpa 接入中（#3651） | 是 |
| Fun-CosyVoice3 0.5B | 顶级，18+ 方言 | 克隆 + 指令 | 仓库 9.3GB | CPU 远低于实时 | 否 | 是（GPU 150ms） | Apache-2.0 | PyTorch / TensorRT | 是 |
| IndexTTS-2.5（2026-08） | 顶级；能用拼音纠正多音字 | 克隆 + 情感 | 5.2GB | 需 GPU（约 6GB 显存） | 否 | 否 | bilibili 模型协议（可商用，MAU 超 1 亿需另行授权） | PyTorch | 是 |
| VoxCPM2 | 顶级，9 种方言 | 克隆 / 设计 | 2B，4.7GB | GPU RTF 0.3（8GB） | 否 | 是 | Apache-2.0 | PyTorch / GGUF | 是 |
| Fish Audio S2-Pro | 顶级 | 克隆 | 4.4B | GPU | 否 | 是 | Fish Research License（**非商用**） | SGLang | 是 |
| F5-TTS / MaskGCT / Spark-TTS | 好 | 克隆 | 0.3–1B | GPU 为主（F5 有 ONNX 版） | 否 | 否 | 权重 **CC-BY-NC(-SA)** | PyTorch | 是 |
| MegaTTS3 | 好（中英） | 克隆受限（WaveVAE 编码器未公开） | 0.45B | GPU | 否 | 否 | Apache-2.0 | PyTorch | 受限 |
| Chatterbox Multilingual | 支持中文，质量〔未核实〕 | 克隆 | 约 0.5B | CPU 偏慢 | 否 | 否 | MIT（带水印） | 社区 ONNX 版 | 是 |
| 不支持中文 | Kyutai TTS 1.6B（英/法）、Pocket TTS（欧洲语言）、KittenTTS（英）、Supertonic 3（31 种语言不含中文，已归档，OpenRAIL-M）、Dia（英）、VibeVoice-Realtime（无中文）、Inflect（英） | | | | | | | | |

### 在线 / 云端（对比用）

| 方案 | 中文 | 价格 | 备注 |
|---|---|---|---|
| Edge 在线（现用） | 很好；`src/` 里列了 10 个中文 Neural 音色，含方言 / 港台 | 免费 | 非官方接口（Sec-MS-GEC 签名），随时可能失效或限流 |
| 豆包 Seed-TTS 2.0（火山引擎） | 顶级，有情感、克隆 | 约 5 元 / 万字符〔未核实〕 | 国内首选商用 API |
| MiniMax Speech 2.8 | 顶级 | HD 约 3.5 元、Turbo 约 2 元 / 万字符（阿里云渠道）〔未核实〕 | 也有海外端点 |
| 阿里百炼 CosyVoice / Qwen-TTS API | 很好，有方言 | 按量计费 | 同系模型有开源版 |
| Azure Speech | 和 Edge 同一批声音 | 付费，有官方 SLA | Edge 的正规替代 |

---

## 3. 各方案要点

- **Kokoro v1.1-zh**（[HF](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)）：82M 参数，StyleTTS2 架构，2025-02 发布，之后官方没有出新的中文版本（hexgrad 仓库最后推送 2025-08）。中文音色来自龙猫数据的 100 人专业数据集。已知问题：ONNX 版个别词（如「质量」）发音和 PyTorch 版不一致（[kokoro-onnx #101](https://github.com/thewh1teagle/kokoro-onnx/issues/101)，未解决）。多音字靠 sherpa 的 `lexicon-zh.txt` 加 jieba 词典处理，没有上下文模型。sherpa 文档：[kokoro-multi-lang-v1_1](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)。
- **sherpa-onnx 当前的 TTS 家族**（[tts-models 发布页](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)，共 644 个文件）：VITS（Piper / MMS / icefall / MeloTTS / 各种 zh-hf 角色音）、Matcha、Kokoro（en v0.19、multi-lang v1.0/v1.1 及 int8 版）、Kitten v0.8（英）、ZipVoice（中英克隆）、PocketTTS（欧洲语言克隆）、Supertonic 1/3（无中文）、Inflect（英）、Nabra（阿拉伯语，基于 Kokoro 运行时）。中文可用的是 Kokoro、Piper zh_CN、Matcha zh、MeloTTS zh_en、ZipVoice、aishell3（174 人，音质较老）和各种 vits-zh-hf 角色音。
- **Piper zh_CN 新音色**（[PR #3546](https://github.com/k2-fsa/sherpa-onnx/pull/3546)，2026-04）：拼音音素化，配 G2PW 词典（`lexicon-zh-g2pw.txt`）和规则 FST，处理数字、日期、电话。int8 版只有 13MB，适合 Android 的保底方案和低配 Windows。
- **MOSS-TTS-Nano**（[GitHub](https://github.com/OpenMOSS/MOSS-TTS-Nano)）：纯自回归的「音频 tokenizer + LLM」结构，输出 48kHz 立体声。2026-04-17 推出独立的 ONNX CPU 版，导出了 prefill / decode_step / local_decoder 等多个图，要自己写解码循环。官方另有 [MOSS-TTS-Nano-Reader](https://github.com/OpenMOSS/MOSS-TTS-Nano-Reader)，场景和听书一致。README 的 License 一节写着「以根目录 LICENSE 为准」，GitHub 识别为 Apache-2.0，HF ONNX 权重也标了 apache-2.0。
- **Qwen3-TTS**（[GitHub](https://github.com/QwenLM/Qwen3-TTS)，2026-01）：0.6B / 1.7B 两档，有 CustomVoice（预置音色）、Base（克隆）、VoiceDesign（1.7B）三种。社区有 [GGUF](https://github.com/HaujetZhao/Qwen3-TTS-GGUF)、[纯 C](https://github.com/gabriele-mastrapasqua/qwen3-tts)、[ONNX Runtime](https://github.com/zhangluoyang/qwen3-tts-onnxruntime) 等移植。
- **OmniVoice**（[GitHub](https://github.com/k2-fsa/OmniVoice)，2026-04）：Qwen3-0.6B 骨干，非自回归掩码解码，支持 600+ 种语言和中文方言，可以用带声调的拼音纠正读音。sherpa 维护者起初质疑它「能在端侧实时」的说法，现在有新的接入 issue（#3651）。
- **Fun-CosyVoice3**（[HF](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)，2025-12）、**IndexTTS-2.5**（[HF](https://huggingface.co/IndexTeam/IndexTTS-2.5/blob/main/README.md)，2026-08）、**VoxCPM2**（[arXiv 2606.06928](https://arxiv.org/html/2606.06928v1)）、**Fish S2**（[博客](https://fish.audio/blog/fish-audio-open-sources-s2/)）：中文质量第一梯队，适合服务端或 GPU，不适合阅读器内置。如果以后做「自建服务器听书」，可以考虑 CosyVoice 3 或 VoxCPM2（都是 Apache）。
- **许可陷阱**：F5-TTS 权重是 CC-BY-NC（Emilia 数据，[README](https://github.com/swivid/f5-tts)）；Spark-TTS 改成了 CC-BY-NC-SA（[HF](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)）；MaskGCT 改成了 CC-BY-NC；Supertonic 权重是 OpenRAIL-M，且没有中文（[HF](https://huggingface.co/Supertone/supertonic-3)）；VibeVoice 的长文本 TTS 代码在 2025-09 因被滥用而撤下。
- **Android 实测参考**〔未核实〕：有资料说 Pixel 级手机上 Kokoro int8 用 4 线程约 RTF 1；骁龙 8 Gen3 每分钟能生成 20–40 秒音频，中端 8 核机每分钟 60–90 秒。数字之间互相矛盾，必须在 K70 / K30 Pro 上自己测。第三方 sherpa Android TTS 引擎可参考 [VoxSherpa-TTS](https://github.com/CodeBySonu95/VoxSherpa-TTS)。

---

## 4. 接入路线（LightRead）

**P0：桌面小改（可随 v1.5.x 发）**
1. 在 `local_tts.rs` 的 `build_engine()` 里设置 `OfflineTtsConfig.rule_fsts = "<root>/phone-zh.fst,<root>/date-zh.fst,<root>/number-zh.fst"`，前提是文件存在，缺文件时跳过。补一个「2026年10月4日 / 3.14 / 13800138000」的朗读用例。
2. `sherpa-onnx = "1.13.8"`。这个 crate 没有声明 rust-version，要用 CI 的 Rust 最低版本门禁（项目是 1.87.0）验证能否编译；再跑 `cargo test agent` 和本地 Kokoro 测试（`KOKORO_MODEL_DIR`）。
3. 语音包增加「精简版（int8，140MB）」选项，供低配机器使用。下载 URL 和目录名做成按包名的常量（目前写死成 `kokoro-multi-lang-v1_1`）。需要试听并测 RTF 后再决定默认用哪个。
4. 加一个用户发音词典，用来纠正多音字和专有名词：sherpa 的 `lexicon` 支持逗号分隔多个文件，可以把用户词典放在最前面。冲突时以哪个文件为准还需要验证〔未核实〕。

**P1：Android PoC（最大收益）**
1. 按官方 Tauri 示例的做法，把 `Cargo.toml` 里 sherpa-onnx 的 `cfg(not(android/ios))` 限制放开到 Android，由 `build.rs` 把 `libsherpa-onnx-c-api.so` 和 `libonnxruntime.so` 拷进 `gen/android/app/src/main/jniLibs/arm64-v8a`。只做 arm64，和现有发布门禁一致。要确认 APK 体积增量〔未核实，onnxruntime arm64 大约十几 MB〕，以及 `check-release.mjs` 的 ABI 检查。
2. 模型继续在应用内下载，不打进 APK。手机上优先测 Kokoro int8（140MB）。如果 RTF 超过 0.7，就改用 Piper zh_CN int8（13MB，2 个音色）或 Matcha zh-en，同时保留系统 TTS 和 Edge。
3. 在 K70 / K30 Pro 上记录 RTF、首句延迟、发热和耗电，以及播放时 WebView 是否卡顿（线程数要比桌面更保守，建议 2）。

**P2：多模型目录**：sherpa 的 `OfflineTtsModelConfig` 已经统一了 Kokoro、VITS/Piper、Matcha、ZipVoice 的配置。可以做一个模型目录（id、家族、URL、文件、音色表、体积、平台），让用户在设置页挑语音包，前端 `localTts.ts` 只多一个 `modelId` 参数。

**P3：高品质实验（桌面，可选）**：用 `ort` crate 做一个 MOSS-TTS-Nano 原型；或者等 sherpa-onnx 接入 OmniVoice / ZipVoice 新版后直接复用。Qwen3-TTS（GGUF）只作为「高配机器 / 克隆」的附加包评估。在线方面可以加 BYOK 云引擎（豆包 / MiniMax / 百炼），复用现有的 Edge 分段与预取调度。

---

## 5. 风险

- **许可**：很多「开源」TTS 的权重受训练数据（如 Emilia）限制，只能非商用。LightRead 是开源应用，但会分发安装包，引入前要逐个核对权重许可，不能只看代码仓库的 LICENSE。Piper zh_CN 和 Matcha zh-en 的许可也要核实。
- **质量**：Kokoro 的 ONNX / int8 有已知的发音和伪影问题。中文多音字目前只靠词典，没有上下文模型。换模型前做盲听对比，素材用同一组含多音字、数字、中英混排的书摘。
- **Android 构建**：sherpa 的 Android Rust 支持是 2026-08 才加的，比较新，和 Tauri gradle、固定 debug 签名、ABI 门禁之间可能有兼容问题。手机 CPU 和电池压力也大，低端机可能达不到实时。
- **MSRV / 依赖**：升级 sherpa-onnx 会连带 onnxruntime 版本变化，Windows 上要回归 #8 的卡顿修复。
- **模型下载**：模型托管在 GitHub Releases，国内下载慢。sherpa 文档提供了国内镜像，应用内可以加镜像地址，并沿用代理设置。
- **Edge 在线接口**：非官方协议，随时可能失效，需要一个离线或付费云的兜底方案。
- **机器资源**：本次没有做任何实测，上面的速度数字都要在目标设备上重新测。

---

## 6. GitHub 项目一览（`gh` 查询于 2026-10-04；★ = stars，「更新」= 最近一次 push）

| 仓库 | ★ | 更新 | 许可（代码） | 中文 | 本地 / 离线运行时 |
|---|---|---|---|---|---|
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 15.1k | 2026-09-22 | Apache-2.0 | ✅（Kokoro / Piper / Matcha / Melo / ZipVoice） | ONNX，C/Rust/Kotlin/Swift…，含 Android / iOS / Tauri |
| [hexgrad/kokoro](https://github.com/hexgrad/kokoro) | 9.2k | 2025-08-06 | Apache-2.0 | ✅ v1.1-zh | PyTorch；ONNX 见下 |
| [thewh1teagle/kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | 2.8k | 2026-09-01 | MIT | ✅ | ONNX Runtime |
| [lucasjinreal/Kokoros](https://github.com/lucasjinreal/Kokoros) | 0.8k | 2026-08-04 | - | ✅ | Rust + ONNX |
| [OpenMOSS/MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) | 4.4k | 2026-09-06 | Apache-2.0 | ✅ | ONNX CPU，Android ORT 示例 |
| [OpenMOSS/MOSS-TTS](https://github.com/OpenMOSS/MOSS-TTS) | 4.2k | 2026-09-06 | Apache-2.0 | ✅ | PyTorch（1.7B–8B，GPU） |
| [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | 13.6k | 2026-03-17 | Apache-2.0 | ✅ 优 | PyTorch；社区 GGUF / C / ORT |
| [HaujetZhao/Qwen3-TTS-GGUF](https://github.com/HaujetZhao/Qwen3-TTS-GGUF) | - | - | - | ✅ | llama.cpp |
| [k2-fsa/OmniVoice](https://github.com/k2-fsa/OmniVoice) | 14.2k | 2026-09-28 | Apache-2.0 | ✅ 优 | PyTorch；社区 ONNX |
| [k2-fsa/ZipVoice](https://github.com/k2-fsa/ZipVoice) | 1.1k | 2025-12-02 | Apache-2.0 | ✅ | PyTorch；sherpa-onnx |
| [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice) | 23.8k | 2026-05-25 | Apache-2.0 | ✅ 顶级 | PyTorch / TensorRT（GPU） |
| [index-tts/index-tts](https://github.com/index-tts/index-tts) | 24.3k | 2026-09-29 | bilibili 协议 | ✅ 顶级 | PyTorch（GPU） |
| [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) | 38.3k | 2026-09-30 | Apache-2.0 | ✅ 顶级 | PyTorch；GGUF |
| [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech) | 32.9k | 2026-09-16 | 研究许可 | ✅ 顶级 | PyTorch / SGLang（GPU） |
| [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 62.3k | 2026-10-04 | MIT | ✅ | PyTorch（需微调，GPU 为主） |
| [2noise/ChatTTS](https://github.com/2noise/ChatTTS) | 39.9k | 2026-04-10 | AGPL-3.0 | ✅ 对话风 | PyTorch |
| [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS) | 15.3k | 2026-09-21 | MIT（权重 NC） | ✅ | PyTorch；[DakeQQ/F5-TTS-ONNX](https://github.com/DakeQQ/F5-TTS-ONNX) |
| [SparkAudio/Spark-TTS](https://github.com/SparkAudio/Spark-TTS) | 11.0k | 2025-04-09 | Apache（权重 NC-SA） | ✅ | PyTorch |
| [bytedance/MegaTTS3](https://github.com/bytedance/MegaTTS3) | 6.1k | 2026-06-15 | Apache-2.0 | ✅ | PyTorch |
| [open-mmlab/Amphion](https://github.com/open-mmlab/Amphion)（MaskGCT） | 10.3k | 2026-03-25 | MIT（权重 NC） | ✅ | PyTorch |
| [myshell-ai/MeloTTS](https://github.com/myshell-ai/MeloTTS) | 7.7k | 2024-12-24 | MIT | ✅ | PyTorch；sherpa-onnx |
| [rhasspy/piper](https://github.com/rhasspy/piper) → [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) | 11.3k / 5.8k | 2025-08 / 2026-09-28 | MIT → GPL-3.0 | ✅（3 个 zh_CN） | ONNX；sherpa-onnx（只用模型，不链接 GPL 代码） |
| [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) | 26.7k | 2026-07-21 | MIT | ✅（多语言版） | PyTorch；社区 ONNX |
| [zai-org/GLM-TTS](https://github.com/zai-org/GLM-TTS) | 1.1k | 2026-04-10 | Apache-2.0 | ✅ | PyTorch（GPU） |
| [netease-youdao/Confucius4-TTS](https://github.com/netease-youdao/Confucius4-TTS) | 0.8k | 2026-09-03 | 自定义 | ✅ | PyTorch |
| [studio-dots-ai/dots.tts](https://github.com/studio-dots-ai/dots.tts) | 1.4k | 2026-09-28 | Apache-2.0 | ✅ 多语言克隆 | PyTorch；MLX 移植 |
| [stepfun-ai/Step-Audio-EditX](https://github.com/stepfun-ai/Step-Audio-EditX) | 1.0k | 2026-04-09 | Apache-2.0 | ✅ | PyTorch（3B，GPU） |
| [FireRedTeam/FireRedTTS2](https://github.com/FireRedTeam/FireRedTTS2) | 1.4k | 2025-10-26 | Apache-2.0 | ✅ 对话 | PyTorch |
| [Soul-AILab/SoulX-Podcast](https://github.com/Soul-AILab/SoulX-Podcast) | 3.6k | 2025-12-11 | Apache-2.0 | ✅ 方言播客 | PyTorch |
| [boson-ai/higgs-audio](https://github.com/boson-ai/higgs-audio) | 8.4k | 2026-06-05 | Apache-2.0 | ✅ | PyTorch（GPU） |
| [canopyai/Orpheus-TTS](https://github.com/canopyai/Orpheus-TTS) | 6.3k | 2025-12-05 | Apache-2.0 | ⚠️ 中文研究预览版 | PyTorch / vLLM（3B） |
| [HuiResearch/FlashTTS](https://github.com/HuiResearch/FlashTTS) | 0.6k | 2025-05-18 | - | ✅ | Spark / Orpheus 推理服务 |
| [PaddlePaddle/PaddleSpeech](https://github.com/PaddlePaddle/PaddleSpeech) | 12.7k | 2026-08-12 | Apache-2.0 | ✅（FastSpeech2 等） | Paddle；有 ONNX 导出 |
| [DakeQQ/Text-to-Speech-TTS-ONNX](https://github.com/DakeQQ/Text-to-Speech-TTS-ONNX) | 70 | 2026-09-04 | Apache-2.0 | ✅（多模型 ONNX 导出） | ONNX Runtime |
| [CodeBySonu95/VoxSherpa-TTS](https://github.com/CodeBySonu95/VoxSherpa-TTS) | - | - | - | ✅ | Android 系统 TTS 引擎（sherpa） |
| [DrewThomasson/ebook2audiobook](https://github.com/DrewThomasson/ebook2audiobook) | 20.3k | 2026-10-02 | Apache-2.0 | ✅（多引擎） | 电子书转有声书，可参考 |
| [readest/readest](https://github.com/readest/readest) | 24.9k | 2026-10-04 | AGPL-3.0 | - | 同类阅读器，可参考其 TTS 交互 |
| [rany2/edge-tts](https://github.com/rany2/edge-tts) | 12.2k | 2026-03-22 | 其他（见仓库） | ✅ | 在线（Edge 协议参考） |
| 不支持中文（参考）：[KittenML/KittenTTS](https://github.com/KittenML/KittenTTS) 15.5k、[kyutai-labs/pocket-tts](https://github.com/kyutai-labs/pocket-tts) 9.8k、[supertone-oss-archive/supertonic](https://github.com/supertone-oss-archive/supertonic) 13.8k（已归档）、[nari-labs/dia](https://github.com/nari-labs/dia) 19.4k、[kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling) 3.0k、[microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) 54.6k、[neuphonic/neutts](https://github.com/neuphonic/neutts) 6.3k | | | | ❌ | |

> 表中 `-` 表示没有查询。stars 和更新时间会随时间变化，以链接页面为准。
