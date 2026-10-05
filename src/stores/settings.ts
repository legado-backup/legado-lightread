import { defineStore } from 'pinia'
import { watch } from 'vue'

export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  /** 页边距百分比 */
  gap: number
  /** 阅读主题; auto 跟随界面外观在浅色/夜间间切换 */
  theme: 'auto' | 'light' | 'sepia' | 'green' | 'dark'
  flow: 'paginated' | 'scrolled'
  maxColumnCount: 1 | 2
  fontFamily: string
  justify: boolean
  /** 页脚 / 底栏的阅读进度显示: 页码 + 百分比 / 只看页码 / 只看百分比 */
  progressDisplay: 'both' | 'page' | 'percent'
}

export interface PdfPrefs {
  /** 可见页面位图渲染引擎；文字几何与交互仍由 PDFium 提供 */
  renderer: 'mupdf' | 'pdfium'
  /** original: 保留版式；reflow 仅用于兼容旧设置，产品入口已移除 */
  layout: 'original' | 'reflow'
  /** paged: 整页翻页；scroll: 连续滚动（默认） */
  mode: 'paged' | 'scroll'
  /** 快捷适配: fitH 适高整页 / fitW 适宽（默认） */
  fit: 'fitH' | 'fitW'
  /** Sumatra 风格页布局：单页 / 对页 / 书籍封面错位双页 */
  spreadMode: 'single' | 'facing' | 'book'
}

/** 打字机模式 (docs/reading-modes.md §3.1) */
export interface TypewriterPrefs {
  /** 粒度: 逐字 / 逐句 / 逐行 */
  unit: 'char' | 'sentence' | 'line'
  /** 中文书速度, 字/分 (60–1200) */
  cpm: number
  /** 西文书速度, 词/分 (40–800) */
  wpm: number
  /** 后文: 隐藏 / 淡显 */
  upcoming: 'hidden' | 'ghost'
  punctuationPause: boolean
  /** 墨迹未干: 最新出现的字用强调色 */
  freshInk: boolean
  /** 打字声 (WebAudio 合成) */
  sound: boolean
  /** 打完一页后停留多久再自动翻页, 毫秒 */
  pageDwellMs: number
}

/** 阅读模式 (打字机 / 行聚焦 / 词块引导); 行聚焦与词块引导为后续分期, 先占位设置结构 */
export interface ReadingModePrefs {
  typewriter: TypewriterPrefs
  lineFocus: {
    enabled: boolean
    lines: 1 | 3 | 5
    style: 'shade' | 'bar' | 'box'
    driver: 'manual' | 'pace' | 'tts'
  }
  wordGuide: {
    enabled: boolean
    style: 'auto' | 'alternate' | 'fixation'
    strength: 'light' | 'normal'
  }
}

/** 结构版本: 修正历史默认值时递增 */
const SETTINGS_VERSION = 10

/** v3 时代曾并入用户设置的内置书库 (v4 起社区清单独立远程拉取, 此表仅供迁移清理) */
const BUILTIN_BOOK_REPOS = [
  '0voice/expert_readed_books',
  'Mikoto10032/DeepLearning',
  'guanpengchn/awesome-books',
  'singgel/JAVA',
  'jyfc/ebook',
]

export interface CustomFontRec {
  name: string
  file: string
}

interface SettingsState {
  version?: number
  /** 界面语言 */
  language: 'zh' | 'en'
  /** 界面外观: 跟随系统 / 浅色 / 深色 (阅读正文主题另由 reader.theme 控制) */
  appearance: 'system' | 'light' | 'dark'
  reader: ReaderPrefs
  pdf: PdfPrefs
  /** 导入的自定义字体 (桌面端) */
  customFonts: CustomFontRec[]
  /** 用户自行添加的 GitHub 书库仓库 (owner/repo); 社区清单另行远程拉取 */
  githubBookRepos: string[]
  /** 自动阅读速度: 秒/页 (EPUB 与 PDF 共用) */
  autoReadSeconds: number
  /** 听书引擎: edge 在线神经音色 / local 本地离线神经音色 / system 系统语音 */
  ttsEngine: 'edge' | 'local' | 'system'
  /** 听书语速 (0.5 - 2) */
  ttsRate: number
  /** 系统语音音色名称, 空为自动匹配 (中文优先) */
  ttsVoice: string
  /** Edge 在线音色 id */
  edgeVoice: string
  /** 本地音色编号 (Kokoro 0-102) */
  localVoiceId: number
  /** Web 端跨域代理模板, {url} 为占位符; 桌面端走原生请求无需代理 */
  corsProxy: string
  /** 桌面端网络代理 (http:// 或 socks5://), 书源请求经此代理 */
  httpProxy: string
  /** Calibre 书库文件夹路径 (桌面端) */
  calibrePath: string
  /** 书库存储根目录 (桌面端), 空为默认应用数据目录 */
  libraryRoot: string
  /** AI 助手: 预设 id / 接口地址 / 密钥 / 模型 */
  aiProvider: string
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  /** AI 辅读: 设置页选择的本机引擎与可选手动可执行文件路径 */
  paperAgentEngine: 'codex' | 'claude' | 'pi'
  paperAgentExecutables: Record<'codex' | 'claude' | 'pi', string>
  /** WebDAV 云备份 */
  webdavUrl: string
  webdavUser: string
  webdavPass: string
  /** 设置页选择的 WebDAV 服务商 (jianguoyun/koofr/selfhosted/other); 空为按 webdavUrl 识别 */
  webdavProvider: string
  /** WebDAV 增量同步: 启动 / 切后台 / 退出阅读器及每 5 分钟自动同步 */
  webdavSyncAuto: boolean
  /** 同步时上传 / 下载书籍文件 (关闭则只同步进度、笔记、书单) */
  webdavSyncFiles: boolean
  /** 阅读记录: 每日阅读目标 (分钟), 0 表示不设目标 */
  dailyGoalMinutes: number
  /** 阅读模式 (打字机等) */
  readingMode: ReadingModePrefs
}

const STORAGE_KEY = 'lightread-settings'

const defaults: SettingsState = {
  version: SETTINGS_VERSION,
  language: 'zh',
  appearance: 'system',
  customFonts: [],
  githubBookRepos: [],
  reader: {
    fontSize: 18,
    lineHeight: 1.8,
    gap: 6,
    theme: 'auto',
    flow: 'paginated',
    maxColumnCount: 2,
    fontFamily: '',
    justify: true,
    progressDisplay: 'both',
  },
  pdf: {
    renderer: 'mupdf',
    layout: 'original',
    mode: 'scroll',
    fit: 'fitW',
    spreadMode: 'single',
  },
  autoReadSeconds: 15,
  ttsEngine: 'edge',
  ttsRate: 1,
  ttsVoice: '',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  localVoiceId: 50,
  corsProxy: '',
  httpProxy: '',
  calibrePath: '',
  libraryRoot: '',
  aiProvider: 'siliconflow',
  aiBaseUrl: 'https://api.siliconflow.cn/v1',
  aiApiKey: '',
  aiModel: 'Qwen/Qwen2.5-7B-Instruct',
  paperAgentEngine: 'pi',
  paperAgentExecutables: { codex: '', claude: '', pi: '' },
  webdavUrl: '',
  webdavUser: '',
  webdavPass: '',
  webdavProvider: '',
  webdavSyncAuto: false,
  webdavSyncFiles: true,
  dailyGoalMinutes: 30,
  readingMode: {
    typewriter: {
      unit: 'char',
      cpm: 300,
      wpm: 200,
      upcoming: 'hidden',
      punctuationPause: true,
      freshInk: true,
      sound: false,
      pageDwellMs: 800,
    },
    lineFocus: { enabled: false, lines: 1, style: 'shade', driver: 'manual' },
    wordGuide: { enabled: false, style: 'auto', strength: 'light' },
  },
}

/** 阅读模式是嵌套对象: 逐层合并, 以后新增字段时旧存档自动补默认值 */
function mergeReadingMode(saved: unknown): ReadingModePrefs {
  const d = structuredClone(defaults.readingMode)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return d
  const s = saved as Partial<Record<keyof ReadingModePrefs, unknown>>
  const part = <T extends object>(base: T, v: unknown): T =>
    v && typeof v === 'object' && !Array.isArray(v) ? { ...base, ...(v as Partial<T>) } : base
  return {
    typewriter: part(d.typewriter, s.typewriter),
    lineFocus: part(d.lineFocus, s.lineFocus),
    wordGuide: part(d.wordGuide, s.wordGuide),
  }
}

function load(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(defaults)
    const saved = JSON.parse(raw)
    const savedAgentExecutables = saved.paperAgentExecutables != null
      && typeof saved.paperAgentExecutables === 'object'
      && !Array.isArray(saved.paperAgentExecutables)
      ? saved.paperAgentExecutables
      : {}
    const merged = {
      ...structuredClone(defaults),
      ...saved,
      reader: { ...defaults.reader, ...saved.reader },
      pdf: { ...defaults.pdf, ...saved.pdf },
      paperAgentExecutables: { ...defaults.paperAgentExecutables, ...savedAgentExecutables },
      readingMode: mergeReadingMode(saved.readingMode),
    }
    if (!['codex', 'claude', 'pi'].includes(merged.paperAgentEngine)) merged.paperAgentEngine = 'pi'
    if (!['system', 'light', 'dark'].includes(merged.appearance)) merged.appearance = 'system'
    for (const engine of ['codex', 'claude', 'pi'] as const) {
      if (typeof merged.paperAgentExecutables[engine] !== 'string') merged.paperAgentExecutables[engine] = ''
    }
    // v2: PDF 阅读默认翻页+适高 (纠正早期版本持久化下来的滚动模式)
    if ((saved.version ?? 1) < 2) {
      merged.pdf.mode = 'paged'
      merged.pdf.fit = 'fitH'
    }
    // v3: 曾把内置书库并入用户设置; v4: 社区清单改为远程拉取,
    // 用户设置只保留自行添加的仓库, 清掉当年并入的内置项
    if ((saved.version ?? 1) < 4) {
      merged.githubBookRepos = (saved.githubBookRepos ?? []).filter(
        (r: string) => !BUILTIN_BOOK_REPOS.includes(r),
      )
    }
    // v6: 双页布尔值扩展为 Sumatra 风格的单页 / 对页 / 书籍视图。
    if ((saved.version ?? 1) < 6) {
      merged.pdf.spreadMode = saved.pdf?.spread ? 'facing' : 'single'
    }
    // v7: PDF 产品模型回归原版阅读，连续滚动成为默认主模式。
    // 早期版本曾通过迁移强制所有用户使用翻页，因此在此统一纠正一次。
    if ((saved.version ?? 1) < 7) {
      merged.pdf.layout = 'original'
      merged.pdf.mode = 'scroll'
      merged.pdf.fit = 'fitW'
    }
    // v9: 阅读主题默认改为跟随界面外观; 旧默认 light 视为未显式选择, 一并迁入 auto。
    if ((saved.version ?? 1) < 9 && (saved.reader?.theme ?? 'light') === 'light') {
      merged.reader.theme = 'auto'
    }
    // v10: 界面外观默认改为跟随系统; 旧默认 light 视为未显式选择, 一并迁入 system。
    if ((saved.version ?? 1) < 10 && (saved.appearance ?? 'light') === 'light') {
      merged.appearance = 'system'
    }
    merged.version = SETTINGS_VERSION
    return merged
  } catch {
    return structuredClone(defaults)
  }
}

export const useSettings = defineStore('settings', {
  state: (): SettingsState => load(),
  actions: {
    persistOnChange() {
      let timer: ReturnType<typeof setTimeout> | undefined
      watch(
        () => this.$state,
        state => {
          clearTimeout(timer)
          timer = setTimeout(
            () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)),
            300,
          )
        },
        { deep: true },
      )
    },
    resetReader() {
      this.reader = structuredClone(defaults.reader)
    },
  },
})
