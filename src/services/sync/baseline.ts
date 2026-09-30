/**
 * 同步的本机状态: 设备 id、上次同步的基线、书籍内容 hash 缓存.
 * 存在独立的 IndexedDB `lightread-sync` 里 (网页与 Tauri webview 都可用), 与书库分开,
 * 清掉它只会让下次同步按首次同步处理 (只并集, 不删除).
 */
import type Dexie from 'dexie'
import type { Table } from 'dexie'
import type { SyncBaseline } from './types'

export interface SyncStore {
  /** 本机设备 id, 首次调用时生成并持久化 */
  getDeviceId(): Promise<string>
  loadBaseline(): Promise<SyncBaseline | null>
  saveBaseline(b: SyncBaseline): Promise<void>
  clearBaseline(): Promise<void>
  /** 本地 book id → 文件内容 SHA-256 (书的 id 与内容一一对应, 永不失效) */
  getHashes(): Promise<Map<string, string>>
  setHash(id: string, hash: string): Promise<void>
}

const newDeviceId = () => crypto.randomUUID()

/** 内存实现 (测试用) */
export function createMemorySyncStore(deviceId: string = newDeviceId()): SyncStore {
  let baseline: SyncBaseline | null = null
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
      const b = row?.value as SyncBaseline | undefined
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
