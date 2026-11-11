# QFCA

Cyrene-Agent 的**独立可选 QQ 模块**，通过专属进程接口接入，不使用普通插件 SDK、插件市场加载器或其权限模型。继续使用外部 OneBot v11 后端，不实现 QQ 底层协议。

## 当前状态

这是 [Cyrene-Agent #327](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/327) 拆分的开发增量，**不是可安装发行版**。契约基于 [Draft PR #338](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/338) 的 API 1.0 候选和配套宿主运行时提案，尚未声明任何发布版宿主兼容范围。包为 `private: true`，没有发布、自动安装、迁移或启用行为。

已实现：
- 独立 Node 24 + TypeScript 工程、精确锁文件、Linux/Windows CI 工作流。
- 私有父子 IPC 入口：`hello → initialize → start`，以及 `send / ackInbound / quiesce / stop / ping`。支持 Node `fork` 和 Electron `utilityProcess` 的 `parentPort` API；Electron 真进程尚待宿主实测。
- OneBot v11 反向 WebSocket、Bearer token、固定确认账号、连接代次、白名单、群 @ 规则、有限队列和短期入站去重。
- 文本、Unicode 分片、群回复/@、入站昵称/单层引用、未支持消息的明确占位。后台返回错误正文和凭据不进入模块事件/回执。
- 按原请求 part 报告 `sent / partial / failed / unknown`。只认明确后端成功及 message_id；超时/已发送后断线是 unknown，不自动重试。一个长文本 part 内部分片段已发送后失败，也保守标为 unknown，不能按整个 part 重发。
- 候选发送契约必填 `connectionEpoch`，模块在接收及每个片段发送前校验，避免宿主尚未收到重连事件时将旧轮次回复发给新连接。整个发送操作总预算 120 秒（包含排队），宿主候选等待 130 秒；预算耗尽后不再发送后续片段。
- 停用停止新入站；quiesce 仍可发送宿主已接收轮次的结果，stop 才断开。旧连接和旧 runtimeEpoch 不能给新连接发送。

尚未实现：
- 媒体 broker、媒体流搬迁及实际能力探测。当前 image/audio/file/video/sticker/card 均为 false，入站媒体只生成占位，不下载 URL、不读取主机路径。不是原 adapter 的全功能替代品。
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
- 本版反向 WebSocket 只允许监听回环 IP：IPv4 `127.0.0.0/8`、IPv6 `::1` 及映射到 IPv4 回环的 IPv6（支持压缩/展开/十六进制等价写法）。只接受不带 zone/scope ID 的 IP 字面量，不解析 DNS；`localhost`、`[::1]`、缩写/整数/八进制 IPv4 不接受。推荐宿主提供 `127.0.0.1` 或 `::1`。
- **兼容变化：非回环地址即使提供 Access Token 也拒绝。** `0.0.0.0`、`::`、LAN/WSL 虚拟网卡地址不能直接监听；宿主原 `auto` 若解析到 WSL 网卡、显式 `wsl` 或非回环 `custom` 配置都会初始化失败，不能靠补 token 解锁，也不会自动改为回环。共享 IPC 契约不变，模块返回 `invalid-request`，随后 `start` 返回 `not-initialized`；现有宿主可能只显示初始化失败，需提供相应预检/提示。
- 同机回环连接保持可用，token 仍可配置且会校验；token 不提供加密。跨机器或跨网络命名空间的后端须由部署者配置**经过身份认证的加密隧道**，以模块回环监听端口为终点；不要用明文端口转发把监听重新暴露到网络。模块不创建或验证隧道，也未实现 WSS/证书配置，不能宣称支持直接安全远程监听。
- API 1.0 是候选，不是包信任或宿主版本兼容承诺。`src/contract/runtime.ts` 与配套宿主候选逐字一致；修改必须同步验证双方，不可私自增加另一套 envelope。
- ACK 只用于释放传输压力，不代表 agent 完成。未 ACK 最多等待 30 秒后丢弃等待状态，不重放事件。队列满时拒绝/丢弃新工作；去重只在内存保留 10 分钟、最多 4096 个事件，没有恰好一次投递保证。
- 每个进程实例最多记住 10000 个请求 ID，每个 session 最多接受 10000 个发送 operationId。进程请求预算耗尽会返回 busy、关闭监听并退出 IPC 子进程，让宿主明确显示故障并决定创建新实例，不会永久保持 running 却静默失活；不自动重放、不驱逐旧记录后偷偷允许重放。实例内重启监听不会清除发送去重记录。这是开发版运行预算限制，不是无人值守稳定性承诺。
- 正式宿主不得因为提供了本仓代码就绕过安装来源/完整性验证，也不得默认捆绑或自动下载安装。独立 Node 进程是故障隔离，**不是 OS 权限沙箱**。

## 版权

QFCA 自身 MIT 许可证保留在 `LICENSE`。迁入/改写的 Cyrene-Agent 代码保留 `Copyright (c) 2026 Playa` 及完整 MIT 文本，见 `LICENSES/Cyrene-Agent-MIT.txt` 和 `NOTICE`。再分发必须同时保留这些文件，不能用 QFCA 自身版权覆盖上游归属。
