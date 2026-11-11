# QFCA 离线发行准备（未启用生产）

本工具只准备**未签名候选输入**和临时密钥演练，不能发布、下载、安装或激活 QFCA。

核对基线：QFCA #2 `96c355b97ef81e33afc8da1e80784e7c4a865973`，
Cyrene-Agent #344 `4329d20d9704d18eacc928b5d08cc305029ae567`。
宿主 `package-verifier.ts` / `package-store.ts` 是未发布候选协议。格式一致不代表任何正式 Cyrene 版本支持安装。
生产 `installation-status` 仍为 `release-unconfigured` / `canInstall=false`，旧 NapCat 接线不变。

## 明确的版本与兼容输入

`package.json` 保持 `0.1.0-dev.0`，本改动不选定或发布首个正式版本。
`release:prepare` 强制要求显式稳定 `x.y.z`，不静默剥离 `-dev.0`，不推导 `latest`，不把 Git tag 当信任根。
打包后的 `package.json.version`、签名 manifest 的 `version` 与真实 IPC `hello.moduleVersion` 一致。
入口固定为 `dist/runtime/entry.js`，`dist/index.js` 仍只是库出口。

输入 JSON 必须精确包含：

- `version`：显式候选 `x.y.z`，不得前导零、预发行或 build suffix。
- `releaseSequence`：正安全整数，实际发行应全局单调增加；本工具不申请或分配真实序号。
- `keyId`：只是一段待绑定的发布者标识，不是公钥或授权证明。
- `issuedAt` / `expiresAt`：Unix 毫秒，必须显式给出；不能自动读取当前时间。
- `hostVersionRange`：稳定宿主版本左闭右开范围。
- `targets`：显式的 platform/arch 组合；无默认“全平台兼容”。

API 1.0 使用原始 `negotiateQqApi` 的最高公共 minor 规则；manifest 不改变其契约。
构建核对 9 个原始契约文件与 `contract-provenance.json` 的 SHA-256。
宿主版本范围、API、系统/架构、时间都必须分别通过宿主验证；版本较新不能替代特性探测。
`chunked-v1`、NapCat 实际媒体能力仍按原协商逻辑，不因打包而启用。

`scripts/release/rehearsal-plan.json` 是**故意早已过期的测试配置**：候选版本 `0.0.0`、序号 1、时间 1000–2000 毫秒、临时标识。
其中 host 1.3.7 与 linux/x64 仅用于隔离测试，不是支持矩阵或发行承诺。不得把它用于实际发行。

## 可复现构建与完整闭包

需要 Node 24、锁定 TypeScript 及已填充的 npm cache。首先按开发流程运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run release:rehearse -- scripts/release/rehearsal-plan.json
npm run release:prepare -- scripts/release/rehearsal-plan.json /tmp/qfca.unsigned.json
```

准备步骤本身只有 `npm ci --offline --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund`，
不会退回网络下载，不运行依赖生命周期脚本，不用开发目录的 `dist` 或 `node_modules/ws` 充当成品。
自定义离线缓存可设置 `QFCA_NPM_CACHE`。缺缓存会失败，需先由操作者在受信开发流程准备依赖。
工具通过 npm script 执行，使用该 npm 的 `npm_execpath`，不执行 PATH 中的任意 shell 命令。

每次在新临时目录中用锁定编译器干净编译，再根据锁文件安装生产依赖。目录退出时清理。
显式收入：

- 不含测试的编译 JS / 类型声明。
- 运行依赖 ws **8.21.0** 完整纯 JS 发布文件、原 package.json、README 和 LICENSE。
- QFCA `LICENSE`、`NOTICE`、上游 `LICENSES/Cyrene-Agent-MIT.txt`。
- 契约来源与本次构建来源清单。
- 不含 scripts、devDependencies、凭据或安装钩子的最小 package.json。

ws 当前无必需传递依赖。任何新增生产依赖、ws 版本变化、未审查的包文件都会使工具失败，需重新审查闭包。
它的可选原生 peers `bufferutil` / `utf-8-validate` 不打包，入口先强制禁用两者再载入 ws，
避免从祖先 node_modules 意外加载。测试把可观察的假 native peer 放到祖先目录验证此边界。
这不是 OS 沙箱，也不防同用户权限攻击或恶意 Node 运行环境。

source 文件清单、锁文件 SHA-256、npm ws tarball 的 SHA-512 integrity、Node/TypeScript 版本进入 `docs/build-provenance.json`。
这记录实际输入，不宣称未提交源码等同某 Git commit，也不构成 SLSA 或第三方证明。
固定源码字节、构建平台/架构与工具链、依赖 cache、显式计划时，payload/manifest/transport 字节相同；构建时间、临时目录名、文件 mtime 不进入产物。
跨平台/架构或 Node/TypeScript 版本未承诺相同；来源清单变化也会改变摘要。

## 离线 transport 与签名边界

输出为单个 canonical JSON：`format=qfca-unsigned-candidate-v1`、manifest 的 base64、排序文件清单及各自 base64。
这是工具专用的惰性传输格式，**不是宿主已接线支持的可安装格式**。没有 tar/zip 解压器、shell 或网络处理器。
`decodeUnsigned` 只产生内存 manifest/Map，不执行、落盘或信任包；不从包中取公钥。

manifest 本身逐字段兼容 #344，UTF-8 `JSON.stringify` 原字节，无末尾换行。
每个 payload 文件都有精确 path、size、SHA-256；所有相对路径沿用保守跨平台限制，
拒绝遍历、大小写/目录拼写碰撞、设备名、文件目录前缀冲突、软/硬链接及未知字段。
限制与宿主一致：manifest 256 KiB、2048 文件、每文件 32 MiB、总 payload 64 MiB；transport 限 92 MiB。

Ed25519 签名消息必须是 UTF-8 `Cyrene/QFCA/package-manifest/v1` + NUL + manifest 原字节。
当前 CLI **不接收私钥、不生成/保存生产密钥、不输出签名发行包**。
`release:rehearse` 仅在进程内产生一次性 Ed25519 密钥、同次演练签名/验签后丢弃，输出统计与摘要；不打印/保存任何密钥。
同一内存测试密钥与同一 manifest 的签名字节可重复；不同运行的随机密钥签名不可能要求相同。
未签名 transport 的 SHA-256 只用于复现比对，不证明发布者身份。

独立宿主集成回归另在临时内存中提供测试公钥，验证实际 host verifier/store。
该公钥没有进入生产配置、源文件或持久化信任库。空信任根必须拒绝，即使文件摘要完整。
可复用的独立 host 回归及命令见 [host-checks/README](../scripts/release/host-checks/README.md)，
请在独立 host clone 运行，不在用户工作树临时注入测试。

## 仍需决策与验收

正式生产步骤不能从本演练自动推导，仍需：

1. 首个正式模块版本、明确宿主范围与 OS/arch/Node/Electron 支持矩阵。
2. 发布者、真实密钥托管与操作授权、keyId 绑定、轮换/撤销、过期与序号策略。
3. 受审查的签名/发布流程、可信下载器与离线用户导入 UI。当前未提供生产 signer。
4. Windows/Electron utilityProcess/ACL、安装包、真实 QQ/NapCat 与旧数据升级/回滚验收。
5. 与 #338/#339/#341/#342/#343/#344 的依赖整理；不要重复合并堆叠分支。

本地 Linux 进程/假后端测试不等于 Windows 或真实 QQ 验收，不关闭 #327，也不移除内建 QQ。
