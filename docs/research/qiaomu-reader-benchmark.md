# 对标：乔木阅读 Qiaomu Reader

> 2026-10-07 · 状态：调研稿（未改代码） · 对象：https://github.com/joeseesun/qiaomu-reader（v4.5.14，138 star，Obsidian 社区插件累计下载约 4,600 次）
> 方法：通读仓库（README、DESIGN.md、`docs/` 里的 40 多份验收记录、`src/` 源码、issue、release），看作者在真实 Obsidian 里截的 5 张正式截图。轻阅这边，在本机 `vite preview` 上用 Playwright 实测（1200×800 @2x 和 390×844 @3x 两种尺寸，书用同样 6 本公版 EPUB），用 `getComputedStyle` 量排版数值。
> 没有本地运行乔木：它是 Obsidian 插件，要先装 Obsidian（Electron 桌面应用），这台服务器没有图形界面。下文提到乔木的界面，依据都是仓库里的正式截图和 CSS 源码。
> 截图都在 `docs/research/img/qiaomu/`：`qiaomu-*.jpg` 取自对方仓库（GPL-3.0，只作评论引用），`lightread-*.jpg` 是本次实测。

## 0. 结论

1. **它和 Calibre 没有依赖关系。** 乔木阅读是一个 **Obsidian 插件**，从俄语开源插件 Elton Reader（MIT）派生而来，阅读内核是 foliate-js 和 PDF.js，跟轻阅用的是同一代技术。Calibre 只是 4.4 版加的一个**可选导入入口**（社区 PR #13）：桌面端读本机 Calibre 书库的 `metadata.db`，把选中的书**拷进** Obsidian 仓库。轻阅的「书源 › Calibre 书库」已经有同类功能。
2. 「看着舒服」主要来自 **6 个具体做法**，和功能多少无关（详见 §3）：
   - 内置一款仿宋阅读字体；
   - 正文底色低饱和、偏暖；
   - 工具栏跟着正文主题变色，而且不透明；
   - 品牌色只用在进度和焦点上，主按钮用墨黑；
   - 顶栏只放 5 个常用按钮；
   - 书架上没有格式角标、说明行这类噪音。
3. 产品主线是 **「舒适阅读 → 就地提问 → 保存笔记 → 回到原文」**。每本书自动配一篇 Markdown 阅读笔记，笔记里的 `↩` 能跳回原文。这条链路轻阅还没有：我们的划线和想法出不了应用。
4. **轻阅更强的地方**：独立应用，不依赖 Obsidian；覆盖网页、Android 和桌面三端；有多端同步和账号；格式更全（DjVu、CBR、TXT/MD/HTML）；有书源、书单和私人书库；有听书和多种带读模式；阅读时长自动统计（乔木要手动点 ▶ 才计时）；论文阅读器更完整。
5. 最值得做的是两类。一类是**马上能做的视觉修复**：阅读器顶栏和底栏透字（实测发现的 bug，§3.3）、正文主题配色、默认字体、书架去噪，都是 S 级工作量。另一类是**划线想法导出成 Markdown**，加上**书架上的继续阅读卡和状态筛选**。完整清单见 §5。

---

## 1. 它是什么

| 项 | 内容 |
|---|---|
| 一句话 | 「不离开书页，读懂一个观点，留下一条真正有用的笔记。」中文优先的 Obsidian 电子书 / PDF 阅读器 |
| 形态 | Obsidian 社区插件（`qiaomu-reader`），只有 3 个文件：`main.js` 4.9 MB、`styles.css` 3.7 MB（内嵌字体）、`manifest.json` |
| 来源 | 派生自 [Elton Reader](https://github.com/swayinfo/elton-reader)（MIT，作者 Elton Labs，俄语）。`NOTICE.md` 写明部分代码沿用 MIT。向上游请求授权的 issue #14 仍未关闭。仓库里的 `docs/promo-*.jpg` 是上游的俄语宣传图 |
| 技术 | 原生 JS（无框架）、esbuild；foliate-js（EPUB/MOBI/AZW3/FB2/CBZ）、pdfjs-dist 6、JSZip、localForage；`src/main.js` 一个文件 70 万字符 |
| 平台 | 跟着 Obsidian 走：macOS、Windows、Linux、iOS、Android。本机 CLI 形式的 AI 只能在桌面用。移动端触屏还没有专门验收过（README 自己写明了） |
| 数据 | 书放在 Obsidian 仓库里，进度和设置存在插件的 `data.json`，笔记是普通 `.md` 文件。多端同步交给 Obsidian Sync 或其他第三方同步，插件本身没有账号、没有遥测 |
| 安装 | 先装 Obsidian，然后：设置 → 第三方插件 → 开启社区插件 → 浏览 → 搜索「Qiaomu Reader」→ 认准作者「向阳乔木」→ 安装 → 启用 → 点左侧书库图标。**从 Obsidian 装好算起要 6–7 步**。另有 BRAT 和手动放 3 个文件两种方式 |
| 目标用户 | 已经在用 Obsidian 做知识管理的中文读者：读书要做笔记、愿意折腾 AI，很多人本机就装着 Codex / Claude / Kimi 这类 CLI |
| 节奏 | 2026-09-09 建仓，一个月发了约 40 个版本。每次改动都配一份验收记录，写清楚测试数、真机验证范围和没验证的部分 |
| 许可 | **GPL-3.0-only**，另附商业授权联系方式；内置字体是 OFL-1.1；示例书保留 Gutenberg 许可 |

## 2. 功能清单（对照轻阅）

图例：●有 ◐部分 ○没有

| 领域 | 乔木阅读 | 轻阅 | 说明 |
|---|---|---|---|
| **格式** | EPUB、PDF、MOBI、AZW3、FB2、CBZ | EPUB、MOBI、AZW/AZW3、FB2、CBZ/CBR、DjVu、PDF、TXT、HTML、MD | 轻阅更全 |
| **书库** | 封面网格、搜索、筛选（全部 / 有划线 / 在读 / 未开始，带数量）、继续阅读卡、每本书显示「进度 · 日期」「N 处划线 · 阅读笔记」 | 封面网格、搜索、排序、书单、标签、批量管理 | 乔木的**继续阅读卡、状态筛选、划线数量**我们没有 |
| **首次体验** | 内置 6 本公版书（道德经、唐诗三百首、世说新语，加 3 本英文书，都带封面），装好就能读；5 页欢迎引导 | 空书架，给出 3 个入口（添加书籍 / 选择文件夹 / 去书源找书） | 乔木打开就能读 |
| **找书** | Gutenberg 应用内搜索和下载；Anna's Archive、Z-Library、Standard Ebooks、维基文库在浏览器里打开 | GitHub 书库、哲学文库、研辞问典、古登堡、Internet Archive、OPDS、私人书库 | 轻阅强很多 |
| **Calibre** | ●（桌面）「从 Calibre 添加」：默认列出「最近在 Calibre 中打开」的书，支持 Calibre 搜索语法，标出「已在书库中」，拷进仓库 | ●（桌面）「书源 › Calibre 书库」直读，可以直接读，也可以加到藏书 | 大致持平；乔木的「最近打开」默认列表和「已在书库中」标记可以学 |
| **阅读排版** | 字号、行距、字体（内置朱雀仿宋，也能选本机字体、导入字体文件）、对齐、单页 / 双页、翻页 / 滚动、「应用推荐排版」（行长上限：中文约 32 字、拉丁文约 72 字符） | 字号、行距、边距、字体（宋 / 黑 / 楷 / 导入）、字距、对齐、翻页 / 滚动、跨章连续、双栏、竖屏单栏 | 轻阅的可调项更多；乔木的默认效果更好看 |
| **主题** | 12 套：跟随 Obsidian、明亮、纸白、宣纸、暖纸、青瓷、竹青、月白、雾蓝、夜间、深海、墨黑；另有墨水屏模式 | 5 个：白色、米黄、护眼绿、夜间、跟随外观；墨水屏放在场景里 | 乔木的配色整体饱和度低 |
| **阅读界面外框** | 顶栏和底栏各 48px，不透明，颜色取自正文主题的 `ui` 色；静止几秒后淡出（220ms），显隐不改变分页 | 顶栏和底栏是 86% 透明的应用卡片色，轻点切换显隐 | 见 §3.3 |
| **选文** | 浮条贴着选区出现：划线 ▾（沿用上次颜色）/ 批注 / 问 AI / 复制 / 更多；右键菜单功能相同；点已有划线可以编辑；改颜色、删除可以撤销；按钮的显示和顺序可以自定义 | 浮条固定在顶部居中：4 个颜色圆点 / 写想法 / AI 解读 / 为什么 / 从这里听 / 发送到设备 / ✕ | 我们的浮条离选区远，没有复制，不记颜色 |
| **笔记** | 每本书自动建一篇 Markdown 阅读笔记，划线和批注自动汇总进去，每条引文带 `↩` 回跳链接；可以新建摘录笔记；可以复制带位置的链接 | 「划线想法」面板集中查看、跳转；书签 | **轻阅的划线想法导不出应用**（只能整包备份） |
| **AI** | 侧栏「AI 伴读」：引用卡显示来源、页码、字数；快捷问题（解释一下、举个例子、总结要点……）；输入 `/` 调出提示词库；文字型 PDF 默认附上全文；回答流式渲染成 Markdown，可以存成笔记（标题在本地自动提取）；草稿按书保存。服务商：本机 CLI（Codex、Claude、Grok、Kimi、ZCode，走 ACP 协议）、国产大模型、聚合平台、OpenAI、Ollama | 选中文字点「AI 解读」，打开对话面板；有内置试用额度；论文 Agent、十问、整篇翻译；点睛阅读智能版 | 各有所长：乔木在**引用来源的呈现、快捷问题、存成笔记**上更细；轻阅有**内置额度**，论文场景更深 |
| **查词 / 翻译** | 选一个词弹出查词卡（音标、本句义、义项、例句），选一句弹出译文；默认谷歌翻译，可以改用 AI；生词本（Spaced Repetition 格式），可同步 Anki | 论文里有划词翻译；书籍里只能用「AI 解读」 | 乔木的查词卡做得好 |
| **找回位置** | 跳转后显示「返回刚才的位置」；可以给位置起名做标记 | 跳转后显示「回到第 N 页」；书签 | 持平 |
| **听书 / 带读** | ○ | 听书（离线、在线、系统语音）、自动翻页、打字机、歌词、点睛阅读 | 轻阅独有 |
| **阅读统计** | 每日目标倒计时，要**手动点 ▶** 才开始；阅读历史 | 自动计时、今日目标、阅读记录页 | 轻阅更好 |
| **同步** | 依赖 Obsidian 仓库同步 | WebDAV、轻阅账号、互传 | 轻阅更好 |
| **界面语言** | 9 种 | 中、英 | — |
| **隐私** | README 里有一张联网功能表，逐项列出发送什么、发给谁 | 有隐私说明 | 乔木的表格写法值得借鉴 |

## 3. 为什么「看着、用着更舒服」

### 3.1 实测数值（同一本《世说新语》，1200×800 视口）

| 项 | 乔木（代码默认值 + 截图估算） | 轻阅（`getComputedStyle` 实测） | 判断 |
|---|---|---|---|
| 正文字号 / 行高 | 默认 18px / 1.8；截图约 20px / 36px | 18px / 32.4px（1.8） | 行高比例一样，**差别不在字号** |
| 正文字体 | **内置朱雀仿宋子集**（GB2312 范围 7,554 字，woff2 2.6 MB，OFL） | 默认值为空，最后落到书里的 CSS 或浏览器默认：西文 Times New Roman，中文用系统字体回退（Linux、Windows 上通常是黑体或雅黑） | **差别最大的一项**。仿宋的笔画细、字面小、字距松，看起来像书；黑体正文像网页 |
| 对齐 | 左对齐 | 两端对齐 | 中文影响不大 |
| 正文底色 / 文字色 | 截图里用的「青瓷」是 `#eaf0e8` / `#243029`；纸白 `#f8f6f0` / `#24231f` | 白色 `#ffffff` / `#1d2129`；护眼绿 `#c7edcc` | 乔木几套浅色主题的饱和度都只有 3–8%，**没有一套纯白**；我们默认纯白，护眼绿饱和度很高（`lightread-desktop-green.jpg`） |
| 双栏时每栏宽 | 约 453px，按 20px 字号算约 22 字 | 492px，约 27 字 | 都在舒适区间 |
| 页边距 / 栏间距 | 约 82px / 84px | 72px / 72px | 接近 |
| 顶栏按钮 | 返回 + 书名 + **5 个**（阅读笔记、AI、专注、阅读设置、更多） | 返回 + 书名 + 章名 + **10 个**（目录、笔记、书签、听书、AI、点睛、搜索、自动翻页、排版、全屏） | 我们的顶栏太挤 |
| 底栏 | 目录、搜索、‹、**居中显示章名**、百分比、› | 跳到开头、进度滑条、跳到结尾、页码与百分比 | 乔木的底栏告诉你「读到哪一章」，我们的给你一根拖动条 |
| 书架标题 | 25px / 700，字距 -0.035em | 20px / 650 | 乔木的标题更有分量 |
| 书架卡片 | 网格最小 168px；封面圆角 8px，带 1px 细边和柔和投影；悬停时上浮 4px；书名 13.5px / 650 | 卡片宽 143px；**每张封面左上角都有「EPUB」角标**；书名 13px / 550 | 角标是噪音 |
| 主按钮 | **墨黑底、白字**（「添加图书」） | `#1664FF` 品牌蓝 | 乔木界面里几乎只有黑、白和书封的颜色 |

### 3.2 六个原因（按影响从大到小）

1. **字体决定了「书感」。** 一款统一的中文书籍字体，比任何间距微调都管用。乔木新装就默认用仿宋，用户不需要找到「字体」这个设置。轻阅默认值为空，结果是西文用衬线、中文用系统无衬线，两者混排，在 Windows 和 Linux 上尤其明显。
2. **低饱和的纸色。** 乔木 11 套浅色主题的底色都是灰度上带一点色相的「纸」（青瓷、宣纸、月白）。轻阅默认纯白，「护眼绿」`#c7edcc` 是微信读书那一代的高饱和绿，大面积铺开显得「电子屏」。
3. **外框跟着正文走，不抢戏。** 乔木的工具栏颜色取自主题的 `ui` 色（比正文底色深一档），书页和工具栏像一张纸上的两个区域。轻阅的工具栏是应用卡片色，正文换成米黄或护眼绿后，**上下仍是两条白边**（`lightread-desktop-green.jpg`）。
4. **品牌色克制。** 乔木的 DESIGN.md 明确规定「强调色只给进度和焦点，不用于装饰」，查词卡连宿主的紫色也禁用，主按钮用墨色、深色主题下反色。轻阅的排版面板里，滑条、分段控件、主题选中圈全是饱和蓝（`lightread-phone-typeset.jpg`），跟纸色正文放在一起有点冲。
5. **常用的少、低频的藏起来。** 顶栏只放 5 个按钮，其余进「更多」；阅读设置第一屏只有主题、字体、字号、行距，其余收进「更多阅读设置」；AI 的接口地址、CLI 路径等高级选项默认折叠。轻阅的排版面板已经按这个思路改过（`docs/reader-panels.md`），但顶栏还是 10 个按钮平铺。
6. **书架上没有噪音，只有有用的信息。** 乔木的卡片下方只有「6% · 9月10日」「0 处划线 · 阅读笔记」，上方是一张「继续阅读」卡。轻阅的书架上有格式角标、常驻的格式说明、只有「全部藏书 0」的书单区，空状态里还把格式清单写了两遍，而且是小写扩展名（违反 `copy-guidelines.md` 原则 2）。

另外两点：乔木把「选中后在哪里出现浮条」「点空白关闭浮条时不能顺便翻页」「拖选过程中不弹浮条」这些细节逐条写进验收记录（`docs/reading-experience-checklist.md`）。很多「顺手」的感觉，来自这些防误触的处理。

### 3.3 实测发现的轻阅问题（可以直接修）

- **阅读器顶栏和底栏透字。** `ReaderView.vue` 的 `.bar` 同时写了 `backdrop-filter: blur(12px)` 和 `-webkit-backdrop-filter`。但构建产物 `dist/assets/ReaderView-*.css` 里**只剩带前缀的那一条**（lightningcss 按旧 WebView 目标处理时丢掉了不带前缀的写法；`LibraryView` 的 CSS 没有这个问题）。Chromium 系内核（Chrome、Edge、Windows WebView2、Android WebView）只认不带前缀的写法，所以栏背景就成了 86% 不透明、没有模糊的白色，正文从栏下透出来，栏后面的页眉文字（例如「Produced by Yi-Shan Lee」）和书名叠在一起。见 `lightread-phone-reader-chrome.jpg`、`lightread-desktop-green.jpg` 右下角。Safari 和 macOS 的 WKWebView 不受影响。
- **工具栏不跟正文主题变色**（原因 3），切到米黄或护眼绿时最明显。
- **空状态和书架的文案**：格式清单出现两遍，用小写扩展名；常驻提示「可添加 EPUB、AZW…支持多选和拖入」在书架有书以后仍然显示。
- 手机竖屏时，添加书籍的 toast 正好盖住标题栏和搜索框（`lightread-phone-library.jpg`）。

## 4. 逐项对比

| 领域 | 乔木做得更好 | 轻阅做得更好 |
|---|---|---|
| 上手 | 示例书打开就能读；欢迎引导 | 装好就能用，不需要先装 Obsidian、开社区插件；网页版打开就能用 |
| 书架 | 继续阅读卡；按「有划线 / 在读 / 未开始」筛选并显示数量；卡片上显示划线数和笔记入口；墨色主按钮 | 书单、标签、批量管理、排序；书源和私人书库 |
| 正文观感 | 内置阅读字体；低饱和纸色；工具栏跟随主题；底栏显示章名 | 可调项更多（字距、跨章连续、竖屏单栏）；场景一键切换（夜读、护眼、大字、沉浸） |
| 选文和笔记 | 浮条贴近选区；复制；记住上次颜色；可撤销；笔记是 Markdown 文件，带回跳链接 | 想法面板；从选中处开始听书；划词发送到其他设备 |
| AI | 引用卡（来源、页码、字数）；快捷问题和 `/` 提示词库；回答存成笔记，标题本地生成；能直接复用本机 CLI 账号 | 内置免费额度；论文 Agent、十问、整篇翻译；点睛阅读 |
| 查词 | 上下文查词卡 + 生词本 + Anki | — |
| 听和带读 | — | 听书、自动翻页、打字机、歌词 |
| 多端 | — | 网页、Android、桌面；WebDAV、账号、互传 |
| 工程纪律 | 每次改动都有验收记录，写明「没验证什么」 | 有完整的 e2e 套件和发版门禁 |

## 5. 建议（按优先级）

工作量：S ≈ 半天到 1 天，M ≈ 2–4 天，L ≈ 1 周以上。所有新增文案都按 `docs/copy-guidelines.md` 写，中英两个字典同时加。

### P0：低成本、马上能感觉到

| # | 读者得到什么 | 具体改法 | 工作量 | 涉及文件 |
|---|---|---|---|---|
| P0-1 | 工具栏不再透字，换主题时书页和工具栏是一体的 | ① `.bar` 和 `.fs-exit` 只写不带前缀的 `backdrop-filter`，让 lightningcss 自己补前缀；修完核对 `dist` 产物里两种写法都在，并补一条 `test:compat` 断言。② 在 `READER_THEMES` 里给每个主题加 `ui` 色（底色向文字色混 4–6%）和 `border` 色，工具栏和底部抽屉改用它，并且**不透明**（可以去掉 blur，省 GPU）。③ 工具栏显示时，隐藏栏后面的页眉页脚文字 | S | `src/views/ReaderView.vue`（`.bar` 一段），`src/services/readerTheme.ts`，`scripts/` 里 compat 相关测试 |
| P0-2 | 正文像纸，不像屏幕 | 调整正文主题色值，键名、顺序和 5 个圆点都不变（e2e 依赖 `.theme-btn` 有 5 个、第 3 个是护眼绿）。建议：白色改成「纸白」，底色约 `#fbfaf7`；护眼绿降饱和，约 `#e4eee0`；米黄约 `#f6efe2`；夜间文字色稍暗一点，避免发光。高亮色和朗读标记色跟着复核对比度（≥ 4.5:1）。改完找负责人对着截图确认。习惯了旧护眼绿的读者可能会觉得「变淡了」，可以在发版说明里提一句 | S | `src/services/readerTheme.ts`，`docs/manual/` 里的主题截图 |
| P0-3 | 中文书默认就是「书的字」 | 不再用空字符串当默认字体，按书的语言给一套一致的衬线字体栈：中文用 `"Songti SC","Noto Serif CJK SC","Source Han Serif SC","Noto Serif SC",SimSun,serif`，西文用 `Georgia,"Times New Roman",serif`。书内 CSS 声明了字体的照旧尊重。只改 `fontDefault` 的解析结果，不迁移已保存的设置 | S | `src/services/readerTheme.ts`（`FONT_FAMILIES`、`getReaderCSS`），`src/views/ReaderView.vue`（`resolveFontFamily`） |
| P0-4 | 书架清爽，一眼只看到书 | ① 去掉封面上的「EPUB」角标，只给非 EPUB 的少数格式（PDF、DjVu、CBZ）显示一个小号、淡色的标签；也可以改到「更多」菜单里。② 书架有书以后隐藏常驻的格式说明。③ 书单区只有「全部藏书」时收成一行（保留「新建书单」「导入书单」按钮，e2e 依赖 `.booklist-action`）。④ 空状态的格式清单只写一遍，改成人话：「支持常见电子书、PDF 和漫画格式」，旁边放「查看全部格式」。⑤ toast 在手机上避开顶栏 | S | `src/views/LibraryView.vue`，`src/components/BookCard.vue`，`src/i18n/zh.ts`、`en.ts`，`src/components/ToastHost.vue` |
| P0-5 | 阅读时干扰更少 | 桌面顶栏只留 5 个高频按钮：**目录、笔记、听书、排版、更多**。书签、搜索、AI、点睛、自动翻页、全屏放进「更多」菜单，或者底栏左侧放搜索、右侧显示章名。e2e 依赖 `button[title="目录"]`、`[title="排版设置"]`、`[title="阅读模式"]`，这些要么留在外面，要么进菜单后保留同样的 title，改完跑 `npm run e2e`、`e2e:full` | M | `src/views/ReaderView.vue`（顶栏、底栏模板），`scripts/e2e-*.mjs` |

### P1：产品层面的补齐

| # | 读者得到什么 | 具体改法 | 工作量 | 涉及文件 |
|---|---|---|---|---|
| P1-1 | 划线和想法能带走，接上 Obsidian、Logseq 或任何笔记软件 | 「划线想法」面板加「导出」按钮，提供两项：「复制为 Markdown」和「保存为 .md 文件」。格式：开头一段 YAML（书名、作者、导出日期、`type: reading-note`），按章节分组，每条是引文（`>`）加想法加位置。桌面版可以在设置里选一个「笔记文件夹」（比如 Obsidian 仓库），之后自动写入或更新这一篇（P2-1）。文案示例：按钮「导出笔记」，说明「把这本书的划线和想法存成一篇 Markdown」 | M | 新增 `src/services/annotationExport.ts`（纯函数，配 `node --test`），`ReaderView.vue` 笔记面板，`PaperReaderView.vue`，i18n |
| P1-2 | 打开书架就知道接着读哪本，划过线的书一眼找到 | ① 书架顶部放「继续阅读」卡：最近读过、还没读完的一本，显示封面、书名、章名、进度条，以及一句最近的划线（如果有）。② 增加状态筛选（分段控件）：全部 · 在读 · 未开始 · 读完 · 有划线，每项带数量，放在书单区上方或与它合并。③ 卡片下方显示一行「35% · 3 条划线」，没读过的书不显示 | M | `src/views/LibraryView.vue`，`src/components/BookCard.vue`，`src/stores/library.ts`，i18n（`// ---- 藏书 ----` 分区） |
| P1-3 | 选完字，手边就是想要的操作 | 划线浮条改成**贴着选区**弹出（放不下就翻到下方，手机上停靠在底部，避开系统选区菜单）。顺序：划线（沿用上次颜色，右侧 ▾ 选颜色）/ 写想法 / AI 解读 / 复制 / 更多（从这里听、发送到设备、为什么）。拖选过程中不弹浮条，松手再弹；点空白关闭浮条时不翻页；改颜色和删除给出「撤销」toast。`e2e-full` 用到了 `.highlight-bar` 和 `.hl-color`，类名保留 | M | `src/views/ReaderView.vue`（`.highlight-bar`、`addHighlight`），`scripts/e2e-full.mjs`，i18n |
| P1-4 | 阅读面板也是「纸」的配色，不刺眼 | 阅读器里的面板（排版、模式、听书）在正文主题下改用中性墨色：滑条、分段控件选中态、主题圆点选中圈都用 `--text` 系，品牌蓝只留给主按钮和焦点环。应用外壳不动 | S–M | `src/views/ReaderView.vue` 面板样式，`src/styles/main.css`（在 `.segmented` 之外新增一个阅读器局部令牌，不改全局） |
| P1-5 | 新用户第一分钟就读上书 | 空书架加一个按钮「放几本书试读」，一键加入 3–6 本公版书，中文古籍和英文名著都有。书**自己从 Gutenberg TXT 生成**（复用 `textToEpub.ts`），不拷乔木打包好的 EPUB；封面用公版扫描图，并逐张核对来源。离线包控制在 1 MB 以内。不默认自动加入：轻阅用户里有一类是「迁移整个书库」的，自动塞书会打扰他们 | M | `src/views/LibraryView.vue` 空状态，`public/starter-books/`，新增构建脚本 `scripts/build-starter-books.mjs`，i18n |
| P1-6 | AI 的回答能留下来，下次还能找到 | 「AI 解读」面板里，每条回答下面放「存为想法」：挂在这次选中的原文上，成为一条带想法的划线，所以 P1-1 导出时会一起带上。问题上方显示引用卡：原文前 2–3 行、章名、字数，点一下回到原文。快捷问题（解释一下、举个例子、总结要点）在输入框上方常驻 | M | `src/views/ReaderView.vue` AI 面板，`src/services/ai.ts`，i18n |
| P1-7 | 读外文书时遇到生词，不用离开书页 | 选中**单个词**时，「AI 解读」直接给出查词卡：本句里的意思（第一行）、音标、常见义项、例句；选中**一句**时给译文。卡片上有「加入生词本」，生词本可以导出成 Anki CSV 或 Markdown。走内置额度或用户自己的 AI | L | 新增 `src/services/lookup.ts`，`ReaderView.vue`，i18n；生词本存储用 `LibraryStorage` 扩展 |

### P2：方向性想法

| # | 想法 | 说明 | 工作量 |
|---|---|---|---|
| P2-1 | 桌面版「笔记文件夹」自动同步 | 选一个本机文件夹（比如 Obsidian 仓库），每本书一篇 `.md`，划线后自动更新。位置链接用 `lightread://open?book=…&cfi=…`，需要 Tauri deep-link 插件，在 Obsidian 里点一下就回到轻阅原文。这是乔木最核心的价值，我们可以在**不绑定 Obsidian** 的前提下做到 | L |
| P2-2 | 内置一款中文阅读字体（可选下载） | 在 P0-3 的基础上，提供朱雀仿宋（OFL）或霞鹜文楷 Screen 子集，**按需下载**，不进首包和 PWA 预缓存，下载后缓存在本地。网页和 Android 端没有好的系统宋体，这一项对它们价值最大 | M |
| P2-3 | 本机 AI CLI 复用（桌面版） | 检测到已登录的 Codex、Claude、Kimi CLI 时，让用户「用我自己的账号」回答，不用再填 API Key。乔木用的是 ACP 协议，在临时目录里运行，并禁止 CLI 读写文件和执行命令 | L |
| P2-4 | 隐私说明改成表格 | 设置页或手册里，按功能列出「发送什么、发给谁、默认开不开」，每次加联网功能都同步更新 | S |
| P2-5 | 静止后自动淡出的阅读外框 | 鼠标几秒不动就淡出工具栏，移动鼠标立刻回来；外框显隐不改变分页。适合放进「沉浸」场景，不改默认行为 | S |

### 不建议照搬

- **隐藏所有 tooltip**（乔木的 `quiet-ui.js`）：我们的约定是图标按钮必须有 `title`，e2e 也依赖它；触屏设备本来就没有悬停。
- **手动开始的阅读计时器**：我们的自动计时更好。乔木自己的文案也承认「忘记按 ▶ 就不会记录」。
- **12 套主题**：选项太多。我们保持 5 个圆点，把每一个调好看（P0-2）就够了。
- **首次启动 5 页引导弹窗**：用示例书和好的空状态代替，和轻阅「少弹提示」的原则一致。

## 6. 许可说明

- 乔木阅读整体是 **GPL-3.0-only**，其中沿用 Elton Reader 的部分保留 MIT。轻阅是 **AGPL-3.0-or-later**。按 GPLv3 和 AGPLv3 各自的第 13 条，两者在法律上**可以合并**分发，但合进来的那部分代码仍然只按 GPL-3.0-only 授权，没有「or later」，会让轻阅的授权变成混合状态，以后改许可或做商业授权时就多了一道障碍。**结论：不拷代码，包括 CSS。只借鉴想法和交互，自己实现。** 本文引用的主题色值只是观察到的数据，P0-2 的建议色值是另外调的。
- **字体**：仓库里的 `QiaomuReadingFangsong.woff2` 是作者从朱雀仿宋 v0.212 预览版做的子集，OFL-1.1，可以再分发。但更稳妥的做法是从上游 https://github.com/TrionesType/zhuque 取原始 TTF，自己做子集（OFL 要求保留版权声明，衍生版本不能用保留字体名）。霞鹜文楷、思源宋体同样是 OFL。
- **示例书**：正文是美国公版，保留了 Gutenberg 的许可声明；EPUB 是乔木的构建脚本（GPL）生成的。我们**自己从 Gutenberg 生成**，不拷他们的文件。封面图要逐张核对来源（他们的 `assets/starter-books/covers/README.md` 列了出处）。
- **截图**：`docs/research/img/qiaomu/qiaomu-*.jpg` 取自对方仓库，只用于本调研文档里的评论引用，不进应用、不进宣传物料。
- foliate-js（MIT）和 PDF.js（Apache-2.0）是双方共同的上游，跟乔木无关。

## 7. 截图索引

| 文件 | 内容 |
|---|---|
| `img/qiaomu/qiaomu-library.jpg` | 乔木书库：墨色主按钮、筛选带数量、继续阅读卡、卡片显示划线数和笔记入口 |
| `img/qiaomu/qiaomu-selection.jpg` | 青瓷主题、仿宋双页、贴着选区的浮条、底栏居中显示章名 |
| `img/qiaomu/qiaomu-notes.jpg` | 书页和 Markdown 阅读笔记并排，引文后面有 `↩` 回跳链接 |
| `img/qiaomu/qiaomu-ai.jpg` | AI 伴读侧栏：引用卡、快捷问题、复制、保存、重新生成 |
| `img/qiaomu/qiaomu-pdf.jpg` | PDF 原页双页显示和独立缩放控件 |
| `img/qiaomu/qiaomu-lookup.jpg` | 上下文查词卡和生词本 |
| `img/qiaomu/qiaomu-calibre-import.jpg` | 「从 Calibre 添加」弹窗 |
| `img/qiaomu/qiaomu-themes-upstream.jpg` | 上游 Elton Reader 的主题宣传图（浅色、暖色、深色、墨水屏） |
| `img/qiaomu/lightread-desktop-empty.jpg` | 轻阅空书架：格式清单写了两遍 |
| `img/qiaomu/lightread-desktop-library.jpg` | 轻阅书架：每张封面都有 EPUB 角标，书单区只有一项，toast 盖住搜索框 |
| `img/qiaomu/lightread-desktop-reader.jpg` | 轻阅白色主题、默认字体、双栏 |
| `img/qiaomu/lightread-desktop-reader-chrome.jpg` | 轻阅工具栏显示时：顶栏 10 个按钮，底栏是进度滑条 |
| `img/qiaomu/lightread-desktop-green.jpg` | 护眼绿主题：高饱和底色、工具栏仍是白条、右下角透字 |
| `img/qiaomu/lightread-phone-library.jpg` | 轻阅手机书架 |
| `img/qiaomu/lightread-phone-reader-chrome.jpg` | 手机滚动模式：顶栏和底栏透字（Chromium 下 `backdrop-filter` 失效） |
| `img/qiaomu/lightread-phone-typeset.jpg` | 手机排版面板：滑条和选中态是饱和蓝，护眼绿圆点饱和度高 |

## 8. 来源

- 仓库与 README：https://github.com/joeseesun/qiaomu-reader（`DESIGN.md`、`NOTICE.md`、`COMMERCIAL-LICENSE.md`、`fonts/README.md`；`docs/` 里的 `reading-experience-checklist.md`、`selection-actions-4.2.0.md`、`library-study-design-4.2.0.md`、`progressive-settings-quiet-ui-4.2.0.md`、`starter-library-settings-4.2.0.md`、`onboarding-4.2.1.md`、`calibre-pr13-review.md`、`showcase.md`；`src/reader-themes.js`、`src/reader-appearance.js`、`src/reader-experience.js`、`src/styles.css`）
- Issue 反馈：#19 加载慢、EPUB 排版像纯文本；#20 想调字距、用滚轮翻页；#21 不要扫描整个仓库，想把书移出书库；#23 想让图标有说明、选中即划线；#24 想用快捷键把选文加入本书笔记；#29 离线词典
- 上游：https://github.com/swayinfo/elton-reader（MIT）；授权请求 https://github.com/swayinfo/elton-reader/issues/14
- 插件统计：https://www.obsidianstats.com/plugins/qiaomu-reader；官方插件页 https://community.obsidian.md/plugins/qiaomu-reader
- 字体上游：https://github.com/TrionesType/zhuque（OFL-1.1）
- 轻阅实测：本机 `vite preview`（:4173）、Playwright 1200×800 @2x 和 390×844 @3x；构建产物 `dist/assets/ReaderView-*.css` 里 `.bar` 只有 `-webkit-backdrop-filter`
