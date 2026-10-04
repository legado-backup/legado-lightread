/**
 * 运行时 polyfill: 补齐旧版 Android/HarmonyOS WebView 和 WKWebView 缺失的标准特性。
 *
 * ReadableStream 异步迭代器 — 系统 WKWebView 缺少 Symbol.asyncIterator,
 * 任何依赖 `for await (const v of readableStream)` 的库都会抛
 * "undefined is not a function" (曾导致 pdf.js 时代论文段落提取整页失败)。
 * 保留以兜底第三方依赖。
 */

// foliate-js 的 EPUB 元数据解析使用 ES2024 分组 API。Vite 转译语法不会补齐这些 API。
if (!('groupBy' in Object) || typeof Object.groupBy !== 'function') {
  Object.defineProperty(Object, 'groupBy', {
    configurable: true,
    writable: true,
    value: function groupBy<T>(items: Iterable<T>, callback: (item: T, index: number) => PropertyKey) {
      if (typeof callback !== 'function') throw new TypeError('Object.groupBy callback must be a function')
      const groups: Record<PropertyKey, T[]> = Object.create(null)
      let index = 0
      for (const item of items) {
        // Computed keys perform ToPropertyKey once, including objects yielding a Symbol.
        const key = Reflect.ownKeys({ [callback(item, index++)]: null })[0]!
        if (Object.prototype.hasOwnProperty.call(groups, key)) groups[key]!.push(item)
        else groups[key] = [item]
      }
      return groups
    },
  })
}

if (!('groupBy' in Map) || typeof Map.groupBy !== 'function') {
  Object.defineProperty(Map, 'groupBy', {
    configurable: true,
    writable: true,
    value: function groupBy<T, K>(items: Iterable<T>, callback: (item: T, index: number) => K) {
      if (typeof callback !== 'function') throw new TypeError('Map.groupBy callback must be a function')
      const groups = new Map<K, T[]>()
      let index = 0
      for (const item of items) {
        const key = callback(item, index++)
        const group = groups.get(key)
        if (group) group.push(item)
        else groups.set(key, [item])
      }
      return groups
    },
  })
}

const rs = typeof ReadableStream !== 'undefined' ? (ReadableStream.prototype as any) : null

if (rs && !rs[Symbol.asyncIterator]) {
  if (!rs.values) {
    rs.values = function (this: ReadableStream, { preventCancel = false } = {}) {
      const reader = this.getReader()
      return {
        async next() {
          try {
            const result = await reader.read()
            if (result.done) reader.releaseLock()
            return result
          } catch (e) {
            reader.releaseLock()
            throw e
          }
        },
        async return(value?: unknown) {
          if (preventCancel) {
            reader.releaseLock()
          } else {
            const cancel = reader.cancel(value)
            reader.releaseLock()
            await cancel
          }
          return { done: true as const, value }
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
    }
  }
  rs[Symbol.asyncIterator] = function () {
    return this.values()
  }
}
