# README 功能截图

`feature-*.png` 是当前 LightRead 网页界面的实际截图，用于[中文 README](../../README.md) 和[英文 README](../../README.en.md)。图片原始尺寸为 1920 × 1350（1280 × 900 视口，1.5 倍像素密度），可点击查看原图。

| 图片 | 展示内容 |
| --- | --- |
| `feature-library.png` | 本地书库、封面、标签与阅读进度 |
| `feature-pdf-translation.png` | 英文 PDF 与中文逐页版式对照 |
| `feature-dianjing.png` | 点睛阅读基础版的本地重点词标记 |
| `feature-booklists.png` | 书单中的已入库书籍、待找条目与分享入口 |
| `feature-reading-stats.png` | 每日目标、阅读时长、趋势与里程碑 |
| `feature-listen.png` | 网页版系统语音听书设置 |
| `feature-reading-modes.png` | 点睛、场景和带读设置 |
| `feature-discovery.png` | 公开书源与内置推荐书单 |

## 演示内容与边界

- 使用一次性 Playwright 浏览器上下文，不读取用户书库、个人设置、凭据或真实阅读记录。
- 示例书名、封面与读物正文由截图脚本生成，仅用于展示，不代表应用附赠图书。PDF 为原创英文演示文本，不是研究论文。
- PDF 中文译文通过本地拦截的固定响应输入真实翻译界面，验证展示流程，不代表实际模型翻译质量或速度。没有调用付费 AI 服务。外部网络请求全部拦截。
- 阅读时长、连续天数和进度是演示数据；书源页展示仓库自带推荐书单，不代表已在线验证每个下载来源。
- 截图保留真实 UI；没有拼接界面、修改 DOM 文案或覆盖应用样式。书籍封面是脚本生成的 SVG，经浏览器栅格化后作为演示封面入库。
- 本组截图为网页版。桌面端的 BabelDOC、本机 Agent 和离线语音模型在 README 中另行说明，未伪造桌面功能截图。

## 重新拍摄

```bash
npm install
npx playwright install chromium
TAURI_ENV_PLATFORM=linux npm run dev -- --host 127.0.0.1
```

另开终端：

```bash
node scripts/capture-readme.mjs
```

脚本需要 Vite 开发服务（通过开发模块接口导入演示内容），默认连接 `http://127.0.0.1:5173`，可用 `E2E_BASE` 指定其他本地开发地址。`TAURI_ENV_PLATFORM=linux` 仅用于跳过 Cloudflare 开发插件，并未将浏览器伪装成桌面应用。

每次运行创建独立浏览器存储。输出覆盖本目录的八张 `feature-*.png`；等待封面加载、点睛标记、PDF 位图和译文后截图，并检查应用没有抛出页面错误。阅读记录的日期随拍摄当天变化。

## App 截图（`app-*.png`）

`app-*.png` 是安卓 App 界面（`src/mobile`，与 `npm run android:build` 相同的界面选择）在 390 × 844、3 倍像素密度的手机尺寸浏览器中的实际渲染，原始尺寸 1170 × 2532。演示书与阅读记录与桌面截图共用（`scripts/readme-demo.mjs`），外部网络全部拦截。

| 图片 | 展示内容 |
| --- | --- |
| `app-library.png` | 藏书：继续阅读、今日时长、标签与书架 |
| `app-reader.png` | 正文：点睛阅读基础版离线标出重点词 |
| `app-reading-modes.png` | 阅读模式：点睛、场景、背景音 |
| `app-typography.png` | 排版「页面」：翻页方式、进度显示、音量键翻页 |
| `app-listen.png` | 听书：定时关闭、音色、语速、剩余时长 |
| `app-sources.png` | 书源：统一搜书、公共书源、私人书库 |
| `app-stats.png` | 阅读记录：今日目标、本周达标、时长趋势 |

浏览器里没有安卓原生壳，脚本注入与 `MainActivity.kt` 同名的空桥（`window.LightReadInsets`），只为让「音量键翻页」等 App 专属设置按真机显示；浏览器无在线语音，听书面板的音色显示为「系统」，真机默认在线语音。点睛阅读通过「模式」面板的开关打开，与用户操作相同。

```bash
TAURI_ENV_PLATFORM=android npm run dev -- --host 127.0.0.1 --port 5174
E2E_BASE=http://127.0.0.1:5174 node scripts/capture-readme-app.mjs
```

`TAURI_ENV_PLATFORM=android` 选择 App 界面并跳过 Cloudflare 开发插件；不要用 `linux`，那样渲染的是桌面界面。

原有 `library.png`、`reader.png` 等截图保留，避免破坏其他文档或外部链接；其中古登堡图书的来源说明沿用原 README。
