# 多端同步协议

轻阅的多端同步是可选的，本地库始终是权威副本。后端可以换（第一步是 WebDAV，第二步是轻阅账号），协议只有一套。

## 设计要点

- **状态型同步，每台设备只写自己的文件。** 每台设备把「自己眼里的完整同步状态」写成 `devices/<deviceId>.json`，合并时读所有设备的文件取并集。WebDAV 没有可靠的锁，只写自己的文件就不会互相覆盖。
- **合并规则是纯函数，满足交换律、结合律、幂等**（CRDT 思路），同步多少次、以什么顺序同步，结果都一样。
  - 普通记录：LWW 寄存器（`{ value, stamp }`，`value === null` 表示已删除，即墓碑）。
  - 书的阅读时长：G-Counter（`reading[deviceId] = 该设备累计贡献的秒数`，总时长为各设备之和，合并时每台设备取较大值）。
  - `stamp = { t: 毫秒时间戳, d: deviceId }`，先比 `t`，相等时比 `d` 的字典序；stamp 完全相同（理论上不会发生）时按值的稳定序列化决胜，保证交换律。
- **书的身份是文件内容的 SHA-256**（`hash`）。各设备本地的 `BookMeta.id` 不同，同步层只认 hash。标注、书单、书源的 ID 是全局 UUID，应用到别的设备时**沿用原 ID**。
- **本地改动靠 diff 得出**：同步时把「当前本地状态」和「上次同步后保存的基线」逐条比较。有变化的记录打上新 stamp；上次在本地、这次不见了的记录生成墓碑。这样不需要改动业务代码的每一处写入。规则细节见下文「本地文档的生成」。
- 基线丢失（清缓存、重装后从旧备份恢复），或换到同类的另一个远端（另一个 WebDAV 地址 / 另一个账号；账号与 WebDAV 之间共用同一份基线）时视为首次同步：**远端优先**，本地只补上远端没见过的记录，本地有的书不会被删，旧备份也不会盖掉别处更新的改动。
- **规范化**：可选字段 `undefined` 与空串 `''` 视为同一个值（都去掉）；元数据补齐缺省值（`kind: 'book'`、`pinnedAt: 0`、`tags: []`），标注 `kind` 缺省为 `highlight`。判等用键序无关的结构比较。

## 远端布局（WebDAV）

```
<webdavUrl>/LightRead/
  lightread-backup.zip           旧的整库备份, 保持不变
  sync/v1/
    devices/<deviceId>.json      每台设备的 SyncDoc
    files/<hash>                 书籍文件 (按内容寻址, 只传一次)
    files/<hash>.cover           封面 (jpeg)
```

## 记录与键

| 集合 | 键 | 值 | 冲突规则 |
|---|---|---|---|
| books | 内容 hash | `meta`（书名/作者/格式/文件名/简介/语言/标签/加入时间/归属/来源/置顶，`pinnedAt: 0` 为未置顶）、`progress`（location/progress/lastReadAt）、`reading`、`alive` | `meta`、`progress`、`alive` 各为独立的 LWW 寄存器；`progress` 的 stamp.t 取 `lastReadAt`，从未读过取 0（读得最晚的赢，而不是同步得最晚的）；`reading` 为 G-Counter |
| annotations | 标注 id | 完整标注，`bookId` 换成 `bookHash` | LWW |
| booklists | 书单 id | `{ name, createdAt }` | LWW |
| booklistItems | `${booklistId}\|${bookHash}` | `{ booklistId, bookHash, addedAt }` | LWW |
| sources | 书源 url | 自定义 OPDS 书源（含鉴权，内置书源不同步） | LWW |

阅读设置、AI 配置等偏好暂不同步。

## 本地文档的生成（`buildLocalDoc`）

按书分三种情况：

| 情况 | meta | progress | alive |
|---|---|---|---|
| 有基线，且上次同步结束时书就在本地（`presentHashes`） | 与基线相同沿用基线寄存器，否则 stamp `now` | 与基线相同沿用，否则 `t = max(lastReadAt ?? 0, 基线 t + 1)` | 基线已是 alive 沿用，否则 `{ true, now }` |
| 新落地的书（有基线，但上次不在本地，如刚导入了一本仅元数据的书） | **沿用已同步的寄存器**（基线，没有则远端），同步过的元数据胜过刚导入的新元数据；都没有才 stamp `now` | 本地 `lastReadAt ?? 0` 大于已同步进度的 t 才用本地值（stamp t 取 `lastReadAt`），否则沿用 | 同上 |
| 首次同步（没有基线） | 远端有寄存器就原样沿用（远端优先），没有才 stamp `now` | 同上一行（仍按阅读时间，读得更晚的本地进度胜出） | 远端是 alive 沿用，否则 `{ true, now }`：本地有文件的书总是存活，**会复活远端已删的书** |

标注、书单、书单条目、书源：

- 有基线：与基线 diff，变了的打 stamp `now`。
- 首次同步：远端有寄存器（**包括墓碑**）就原样沿用，远端删掉的不会被旧备份加回来；远端没有的才 stamp `now`。

### 删除的判定（防误删，只在有基线时）

- 书：基线里是 alive，**且上次同步后本地确实有这本书**（基线的 `presentHashes`），这次本地没有了 → 墓碑。只有元数据、文件还没下到本地的书，不会因为「本地没有」被删。
- 标注：基线里有，所属的书上次在本地（`presentHashes`）**且此刻仍在本地**，本地却没有这条 → 墓碑。
- 书单条目：同上，另外所属书单此刻也要在本地。
- 书整本删了、书单整个删了时，其标注 / 条目不单独生成墓碑，由书或书单的墓碑级联。这样不会把「因书单已删而从未落地」的条目误判为删除；书或书单日后被恢复（重新导入、并发改名胜出）时，里面的内容也一起回来。
- 书单、书源：基线里有、本地没有 → 墓碑。

## 落地到本地（`planApply`）

操作按可执行顺序排列：`addBook → updateBook → addBooklist/renameBooklist → addAnnotation/updateAnnotation → addBooklistItem → addSource →` 各类删除（`removeBooklistItem, deleteAnnotation, deleteBooklist, deleteSource, deleteBook`）。

- **例外**：标注的 cfi/text/kind 等不可原地修改的字段变了、书源内容变了时，产出紧挨着的 `deleteX + addX`（同一 id / url），放在对应的添加阶段，保证先删后加。
- 书在合并结果里已删时，其标注 / 书单条目不再单独产出操作，由 `deleteBook` 级联；书单删除同理由 `deleteBooklist` 级联其条目。新增标注 / 条目要求所属的书（和书单）在合并结果里存活。
- `updateBook` 只带有差异的字段；合并结果里去掉的可选字符串（简介、语言、来源）写成 `''`，标注清空笔记写 `note: ''`；取消置顶写 `pinnedAt: 0`。
- 只有元数据、本地没有的书也会产出 `addBook`，由 engine 决定能否下载文件；引用本地不存在的书的标注 / 条目照样产出，engine 找不到 hash 时跳过（下次书落地后会再次产出）。

## 阅读时长

`myContribution = base.reading[me] + max(0, localTotal - sum(base.reading))`。
基线缺失时：`myContribution = max(0, localTotal - sum(remote.reading 中除我以外的设备))`，再与远端里我原有的贡献取较大值，避免重装后重复计时。
合并后本地总时长写成 `sum(merged.reading)`（只增不减）。

## 一次同步的流程（engine）

1. 读本地库，得到 `LocalState`（按 hash 键，书的 hash 有缓存，只对新书计算）。
2. 远端：列出并读取所有 `devices/*.json`，合并得到 `remoteMerged`。
3. `buildLocalDoc(local, base, presentHashes, remoteMerged)`：给本地改动打 stamp、生成墓碑、更新自己的计时贡献；再与远端文档一起 `mergeDocs`。
4. `planApply(merged, local)` 得到操作列表并应用到本地库：新书要先下载文件（远端有文件时才加入本地，否则保持「仅元数据」状态，等以后导入同一文件时自动匹配）。
5. 上传：本地有、远端还没有的书文件和封面（开启「同步书籍文件」时）。
6. 把合并结果写到 `devices/<me>.json`，并把合并结果和 `presentHashes` 存为新基线（IndexedDB `lightread-sync`）。
7. 刷新书架。

同一时刻只跑一次同步；自动同步在启动、切到后台、退出阅读器时触发，另外每 5 分钟一次。

## 后端接口

后端实现 `SyncRemote`（`src/services/sync/types.ts`）。第二步的账号后端（Cloudflare Worker + D1）实现同一接口，`supportsFiles = false`，只同步元数据。
