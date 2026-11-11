# QFCA

Cyrene-Agent 的**独立可选 QQ 模块**，通过专属进程接口接入，不使用普通插件 SDK、插件市场加载器或其权限模型。继续使用外部 OneBot v11 后端，不实现 QQ 底层协议。

## 当前状态

这是 [Cyrene-Agent #327](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/327) 拆分的开发增量，**不是可安装发行版**。契约基于 [Draft PR #338](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/338) 的 API 1.0 候选和配套宿主运行时提案，尚未声明任何发布版宿主兼容范围。包为 `private: true`，没有发布、自动安装、迁移或启用行为。

已实现：
- 独立 Node 24 + TypeScript 工程、精确锁文件、Linux/Windows CI 工作流。
- 私有父子 IPC 入口：`hello → initialize → start`，以及 `send / ackInbound / quiesce / stop / ping`。支持 Node `fork` 和 Electron `utilityProcess` 的 `parentPort` API；Electron 真进程尚待宿主实测。
- OneBot v11 反向 WebSocket、Bearer token、固定确认账号、连接代次、白名单、群 @ 规则、有限队列和短期入站去重。
- 文本、Unicode 分片、群回复/@、入站昵称/单层引用、未支持消息的明确占位。后台返回错误正文和凭据不进入模块事件/回执。
- 配套宿主显式协商 `mediaTransfer: "chunked-v1"` 后，提供私有 `mediaBeginUpload / mediaWrite / mediaRead / mediaRelease` 媒体通道。未协商时保持旧文本能力和附件占位，不让旧宿主收到无法消费的附件。
- 按原请求 part 报告 `sent / partial / failed / unknown`。只认明确后端成功及 message_id；超时/已发送后断线是 unknown，不自动重试。一个长文本 part 内部分片段已发送后失败，也保守标为 unknown，不能按整个 part 重发。
- 候选发送契约必填 `connectionEpoch`，模块在接收及每个片段发送前校验，避免宿主尚未收到重连事件时将旧轮次回复发给新连接。整个发送操作总预算 120 秒（包含排队），宿主候选等待 130 秒；预算耗尽后不再发送后续片段。
- 停用停止新入站；quiesce 仍可发送宿主已接收轮次的结果，stop 才断开。旧连接和旧 runtimeEpoch 不能给新连接发送。

尚未实现：
- 真实 QQ/NapCat 的媒体验收与后端格式/转码差异验证。媒体仍是未发布的配套候选，sticker/card/markdown 不宣称支持；不是原 adapter 的全功能替代品。
- 模块签名、manifest、发行归档、安装/迁移/回滚及 QQ 设置 UI。`npm pack` 仅开发检查，输出不是宿主可安装模块。
- 真实 QQ/NapCat、Windows 安装包和 Electron utilityProcess 端到端验收。CI 的假后端不等于真实 QQ 验证。
- 主仓默认包移除旧 QQ 实现。此仓不修改主仓启动路径，也不自动切换用户账号或配置。

## 开发验证

需要 Node 24 和 npm。仓库无安装脚本，依赖来自 npm 官方注册表。

```sh
npm ci --ignore-scripts
npm run verify
npm pack --dry-run
```

`verify` 依次运行类型检查、全部单元/本地 WebSocket 测试、干净 TypeScript 构建和编译产物 IPC smoke。smoke 在 127.0.0.1 临时端口启动**假 OneBot**，不用 QQ 账号或外部后端。它覆盖握手、鉴权、入站、ACK、quiesce 后发送、停止及父进程断开退出。

开发库入口为 `dist/index.js`，私有进程入口为 `dist/runtime/entry.js`。直接运行 entry 而没有父进程 IPC 会拒绝启动；导入库不会监听端口。宿主通过私有 IPC 提供确认过的账号、配置快照和 token，不能通过 CLI 参数传 token。

## 边界与兼容

- 历史、会话、记忆、绑定、权限、agent 执行和持久 journal 仍由宿主管理。模块没有这些 API，不读取 `channels-settings.json` 或 Electron userData。宿主必须再次检查白名单、账号和 epoch，且由宿主固定 `qq` 身份。
- 初始化需要宿主已经确认的 `expectedSelfId`。不能把首次陌生连接自动当成旧历史所属账号。本轮不支持多账号或自动换号。
- 宿主负责保留并解析原 `auto / wsl / custom` 设置，向模块提供具体 IP。当前模块只接受 IP 字面量，不自行 DNS 解析；非回环地址强制 token。远程连接没有因此获得 TLS，不能视为安全公网部署方案。
- API 1.0 是候选，不是包信任或宿主版本兼容承诺。`src/contract/runtime.ts` 与配套宿主候选逐字一致；修改必须同步验证双方，不可私自增加另一套 envelope。
- ACK 只用于释放传输压力，不代表 agent 完成。未 ACK 最多等待 30 秒后丢弃等待状态，不重放事件。队列满时拒绝/丢弃新工作；去重只在内存保留 10 分钟、最多 4096 个事件，没有恰好一次投递保证。
- 每个进程实例最多记住 10000 个控制/开始上传请求 ID（分片读写/释放只跟踪进行中的请求，另外以句柄、epoch和严格offset阻止重放），每个 session 最多接受 10000 个发送 operationId。进程请求预算耗尽会返回 busy、关闭监听并退出 IPC 子进程，让宿主明确显示故障并决定创建新实例，不会永久保持 running 却静默失活；不自动重放、不驱逐旧记录后偷偷允许重放。实例内重启监听不会清除发送去重记录。这是开发版运行预算限制，不是无人值守稳定性承诺。
- 正式宿主不得因为提供了本仓代码就绕过安装来源/完整性验证，也不得默认捆绑或自动下载安装。独立 Node 进程是故障隔离，**不是 OS 权限沙箱**。


## 媒体候选边界

- 仅支持当前连接经能力探测确认的 NapCat 扩展，不按版本号猜测能力。`get_version_info.app_name` 必须严格等于 `NapCat.Onebot`，并验证 `can_send_image` / `can_send_record`、`test_download_stream` 全部10片和终态，以及无QQ消息发送的16字节真实分片上传/哈希完成握手。任何失败保留文本；文字就绪不等待探测，完成后以 `capability-changed` 更新。
- 模块只保存私有临时 spool，持久缓存、文件引用和历史归宿主。单文件上限100MiB、IPC块64KiB、总预留512MiB、最多256个活句柄，句柄5分钟过期。私有临时目录和文件不接受调用方选路径；目录权限由系统临时目录机制设为私有，文件以0600排他创建。大文件逐块落盘，不将整个文件载入模块内存。
- 出站句柄绑定连接代次、operationId、conversation、kind、大小和SHA256，必须按连续offset完整写入并通过哈希验收才可消费一次。请求不能提供宿主路径或URL。NapCat返回的上传路径只在模块内部用于对应发送；上传使用随机安全文件名和5分钟后端保留期，不执行全局后端临时文件清理。
- 入站只使用当前事件的opaque `file_id`/`file`（可含安全扩展名），拒绝URL、file://、绝对/相对路径；不会读取事件URL。图片走 `download_file_image_stream`，语音走 `download_file_record_stream` 转MP3，其余走 `download_file_stream`。安全basename和推导MIME可进入附件，路径不进入IPC。图片/文件/视频要求声明大小、实际字节、终态计数一致；NapCat语音转码可能报告原silk大小，因此按100MiB上限预留、按最终实际字节缩额并封存。任何格式错误、超限或下载失败只产生安全附件占位，保留同条文字。
- 断连/换连接/stop立即撤销句柄；迟到回调不能重新写入或把旧探测结果覆盖新连接。ACK不删除附件，宿主读完显式释放或等待TTL。磁盘清理失败仍保留额度并重试，不把清理异常抛出到进程计时器。
- spool以带PID随机私有目录和所有权marker标识。新分配前只在系统选择的临时目录内回收正规文件、marker匹配且PID明确不存在的旧实例（POSIX额外校验同UID和0700目录；Windows stat权限是合成值，不能据此假装已验证ACL），绝不递归或follow symlink。活PID、PID复用、未知旧目录和无法确认归属的内容均不删除；已确认死亡的自有目录清理失败则拒绝新分配，不能靠重启绕过残留配额。进程被kill后的恢复已在Linux隔离子进程验证；Windows权限/ACL与PID行为仍待实机验证。
- 后端stream有每action最多128个排队包、每连接8MiB排队负载上限，遇到无界突发明确失败，不积累无限Promise链。媒体上传失败发生在QQ发送之前时为failed；只有实际消息已提交且结果不明才为unknown，仍禁止盲重发。

本轮协议依据 [NapCat官方源码固定提交72912f2](https://github.com/NapNeko/NapCatQQ/tree/72912f293924f43463b5976b01fc094a8ae11481/packages/napcat-onebot/action/stream) 与同提交的 GetVersionInfo/CanSendImage/CanSendRecord；全部验证只在隔离临时文件和本地fake OneBot完成，不代表真实后端、Windows或Electron验收。

## 版权

QFCA 自身 MIT 许可证保留在 `LICENSE`。迁入/改写的 Cyrene-Agent 代码保留 `Copyright (c) 2026 Playa` 及完整 MIT 文本，见 `LICENSES/Cyrene-Agent-MIT.txt` 和 `NOTICE`。再分发必须同时保留这些文件，不能用 QFCA 自身版权覆盖上游归属。
