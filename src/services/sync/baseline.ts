/**
 * 同步的本机状态: 设备 id、上次同步的基线、书籍内容 hash 缓存.
 * 存在独立的 IndexedDB `lightread-sync` 里 (网页与 Tauri webview 都可用), 与书库分开,
 * 清掉它只会让下次同步按首次同步处理 (只并集, 不删除).
 *
 * 基线是「本机上次同步后所知的全部状态」, 在各远端 (轻阅账号、WebDAV) 之间共用, 不按远端分开:
 * 两个远端是同一套 CRDT 文档, 本机写给每个远端的都是自己所知的全部记录.
 * 若按远端各存一份, 从 A 远端落地到本地的改动在同步 B 远端时会被当成本机新改动重新打 stamp
 * (旧值可能盖过别处更新的改动), 阅读时长也会被记到本机名下重复计算.
 * 基线记下用它同步过的远端 (`remotes`); 换成同类的另一个远端 (换了 WebDAV 地址 / 换了账号) 时
 * 基线对它作废, 按首次同步处理 (只并集), 不把旧远端的记录带过去, 也不产生删除.
 */
import type Dexie from 'dexie'
import type { Table } from 'dexie'
import type { SyncBaseline, SyncRemote } from './types'

/** 本机基线 = 上次同步的合并结果 + 用它同步过的远端 */
export interface DeviceBaseline extends SyncBaseline {
  /** 用这份基线同步过的远端 id (含 remoteId); 旧版基线没有此字段, 视为 [remoteId] */
  remotes?: string[]
}

/** 远端 id 的类别 (`webdav:…` / `account:…`) */
const remoteKind = (id: string) => id.slice(0, Math.max(0, id.indexOf(':')))

export function baselineRemotes(b: DeviceBaseline): string[] {
  return Array.isArray(b.remotes) && b.remotes.length ? [...b.remotes] : [b.remoteId]
}

/**
 * 基线能否用于这个远端: 用它同步过, 或还没同步过同类的其它远端
 * (如已在用 WebDAV, 新登录了账号: 账号是新增的一类远端, 本机所知的状态照样作数).
 * 同类远端换了 (换 WebDAV 地址 / 换账号) 则作废.
 */
export function baselineUsableFor(b: DeviceBaseline, remote: Pick<SyncRemote, 'id'>): boolean {
  const seen = baselineRemotes(b)
  if (seen.includes(remote.id)) return true
  const kind = remoteKind(remote.id)
  return !seen.some(id => remoteKind(id) === kind)
}

/** 同步成功后新基线记录的远端: 基线作废时去掉同类的旧远端 */
export function nextBaselineRemotes(
  prev: DeviceBaseline | null,
  usable: boolean,
  remote: Pick<SyncRemote, 'id'>,
): string[] {
  if (!prev) return [remote.id]
  const kind = remoteKind(remote.id)
  const seen = baselineRemotes(prev).filter(id => usable || remoteKind(id) !== kind)
  return seen.includes(remote.id) ? seen : [...seen, remote.id]
}

export interface SyncStore {
  /** 本机设备 id, 首次调用时生成并持久化 */
  getDeviceId(): Promise<string>
  loadBaseline(): Promise<DeviceBaseline | null>
  saveBaseline(b: DeviceBaseline): Promise<void>
  clearBaseline(): Promise<void>
  /** 本地 book id → 文件内容 SHA-256 (书的 id 与内容一一对应, 永不失效) */
  getHashes(): Promise<Map<string, string>>
  setHash(id: string, hash: string): Promise<void>
}

const newDeviceId = () => crypto.randomUUID()

/** 内存实现 (测试用) */
export function createMemorySyncStore(deviceId: string = newDeviceId()): SyncStore {
  let baseline: DeviceBaseline | null = null
  const hashes = new Map<string, string>()
  return {
    async getDeviceId() { return deviceId },
    // 深拷贝, 模拟持久化 (避免调用方改动已保存的对象)
    async loadBaseline() { return baseline ? structuredClone(baseline) : null },
    async saveBaseline(b) { baseline = structuredClone(b) },
    async clearBaseline() { baseline = null },
    async getHashes() { return new Map(hashes) },
    async setHash(id, hash) { hashes.set(id, hash) },
  }
}

interface KvRow { key: string; value: unknown }
interface HashRow { id: string; hash: string }

/** IndexedDB 实现 (Dexie 按需加载) */
export function createDexieSyncStore(): SyncStore {
  type Db = Dexie & {
    kv: Table<KvRow, string>
    hashes: Table<HashRow, string>
  }
  let dbPromise: Promise<Db> | null = null
  const db = () => {
    dbPromise ??= import('dexie').then(({ default: DexieCtor }) => {
      const d = new DexieCtor('lightread-sync') as Db
      d.version(1).stores({ kv: 'key', hashes: 'id' })
      return d
    })
    return dbPromise
  }
  let deviceId: Promise<string> | null = null

  return {
    getDeviceId() {
      deviceId ??= (async () => {
        const d = await db()
        return d.transaction('rw', d.kv, async () => {
          const row = await d.kv.get('deviceId')
          if (typeof row?.value === 'string' && row.value) return row.value
          const id = newDeviceId()
          await d.kv.put({ key: 'deviceId', value: id })
          return id
        })
      })().catch(err => {
        deviceId = null
        throw err
      })
      return deviceId
    },
    async loadBaseline() {
      const row = await (await db()).kv.get('baseline')
      const b = row?.value as DeviceBaseline | undefined
      return b && typeof b.remoteId === 'string' && b.doc ? b : null
    },
    async saveBaseline(b) {
      await (await db()).kv.put({ key: 'baseline', value: b })
    },
    async clearBaseline() {
      await (await db()).kv.delete('baseline')
    },
    async getHashes() {
      const rows = await (await db()).hashes.toArray()
      return new Map(rows.map(r => [r.id, r.hash]))
    },
    async setHash(id, hash) {
      await (await db()).hashes.put({ id, hash })
    },
  }
}
