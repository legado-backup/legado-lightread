# 私人书库上传适配器

`uploads.py` 提供上传协议、校验、去重和 SQLite 写入；不包含凭据或书籍采集逻辑。它依赖已有私人服务提供的 `catalog` 元数据函数和 `sync.Baidu` 存储接口。完整私人服务源、数据库、配置和凭据仍只保存在服务器。

## 协议

全部数据接口沿用 OPDS 的 HTTP Basic 鉴权，线上使用 HTTPS。

- `GET /api/library`：`{"version":1,"uploadUrl":"/api/upload","formats":["epub","pdf","azw","azw3","mobi"],"maxFileBytes":94371840}`。
- OPDS 根 feed 发布 `rel="https://lightread.app/rel/library"` → `/api/library`，以及 `rel="https://lightread.app/rel/upload"` → `/api/upload`，两者 `type="application/json"`。客户端验证同源能力端点后再上传。
- `POST /api/upload`：原始文件 body（非 multipart）；必须发送准确 `Content-Length`，上限 **90 MiB**。`X-File-Name` 为 `encodeURIComponent` 编码的文件名；可选 `X-Book-Title`、`X-Book-Author` 使用相同编码。
- `Content-Type`：EPUB `application/epub+zip`；PDF `application/pdf`；AZW `application/vnd.amazon.ebook`；AZW3 `application/x-mobi8-ebook`；MOBI `application/x-mobipocket-ebook`。Kindle 三种 MIME 相互兼容，也接受旧 `application/vnd.amazon.mobi8-ebook`；最终格式由文件扩展名确定，并检查容器头。
- 新增返回 HTTP 201，SHA256 已存在返回 HTTP 200：`{"bookId":"<sha256>","title":"书名","format":"pdf","duplicate":false}`。重复上传保留已有书目标题和格式，不再上传远端文件。
- 错误：400 请求/内容不完整；401 未认证；411 缺少/重复 Content-Length；413 超过90 MiB；415 格式/MIME/容器不匹配；408 读取超时；503 上传槽满；507 临时磁盘不足；502 存储或数据库失败（不回显底层凭据）。

EPUB 读取内嵌元数据；其他格式默认使用文件名。用户提供标题、作者时优先使用。EPUB检查mimetype、container文件及全部ZIP条目CRC，限制展开后512 MiB及10000个条目以限制解压资源；PDF检查文件头及末尾EOF；Kindle检查PalmDB记录表、偏移和MOBI头。此接口存储原文件，不转换格式、不移除 DRM；容器校验不等于完整可读性验证。

每次最多2个上传；流式写入权限受限的临时目录，完整校验后才调用远端上传。成功、拒绝或异常均清理暂存文件。数据库沿用既有10列 catalog，格式写在 metadata JSON；历史无格式记录默认 EPUB。手动上传不会伪造采集消息或修改队列。

## 准备和安装

1. 将已运行服务的 **library_server.py、catalog.py、sync.py 三个源文件**复制到受限暂存目录；不要复制 private 目录或凭据。
2. 生成新的待部署目录：

   ```sh
   python3 library-server/stage_adapter.py --source /path/to/source-stage --output /path/to/new-ready-stage
   python3 -m py_compile /path/to/new-ready-stage/*.py
   ```

   脚本只接受尚不存在的输出目录；源版本与预期不符时失败，需人工审查适配。它不会启动服务或部署。输出包含3个适配后的私有源与 `uploads.py`，**不要提交这些私有源**。

3. 审查差异并运行下面的独立和集成测试。先停止定时触发器、等现有采集任务结束，再停OPDS服务；否则旧采集进程不使用新增的跨进程去重锁。备份原3个源，将输出4个文件一起安装到原服务目录，沿用原用户/组及0600权限。无需数据库迁移。
4. 重启OPDS服务并恢复采集触发器。验证鉴权后的 `/api/library`、OPDS两条能力link、样本上传/重复上传/下载。需要回滚时停止服务并恢复原3个源；已上传的非EPUB书目仍在数据库，因此应优先前向修复，旧版服务会错误地把这些文件标成EPUB。

适配会给上传与采集的“SHA256查询 → 远端传输 → catalog提交”添加相同文件锁，防止两个进程同时上传同一本书。使用256个锁桶限制锁文件数量；SQLite连接每线程/任务独立，繁忙超时30秒，网络传输期间不持有SQLite写事务。现有百度客户端自己的令牌锁保持不变。

上传成功后本地 catalog 立即更新，OPDS/API立即可见；远端导出的 catalog.json 仍由既有周期任务发布。

## 验证

```sh
python3 library-server/test_uploads.py -v
/path/to/existing-service-venv/bin/python library-server/test_uploads.py --adapter-dir /path/to/new-ready-stage -v
```

全部测试使用临时数据库、伪造存储客户端和本地HTTP服务，不读取 private 凭据、不写百度网盘。集成模式需要已有服务的 requests、defusedxml、telethon 依赖。覆盖5种格式、中文元数据、重复上传、并发去重、非法格式/大小/头、鉴权、上传繁忙、异常清理、能力发现、CORS、真实下载MIME和扩展名、旧EPUB书目兼容及采集并发。
