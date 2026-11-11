# 独立 host 发行包兼容性回归

`release-independent.fixture` 是 19 项 Vitest 回归，使用真实 host 的相对导入。它通过 `QFCA_RELEASE_ROOT` 动态导入候选打包工具，离线构建并 encode/decode 传输格式，再用仅内存中的临时 Ed25519 密钥验证真实 host verifier/store。不会保存密钥或修改生产信任配置。store 位于系统临时目录，测试后删除。

前提：Node 24；已审查的 QFCA checkout 与 host checkout；两者依赖已准备；npm 缓存已有锁定 ws tarball。QFCA checkout 必须包含 scripts/release/package.mjs 和 rehearsal-plan.json。使用演练计划的固定版本、linux/x64 target 与时间 1000–2000，不用于当前时间的发布验证。

在独立 host clone 中执行以下命令。设置四个变量为本机绝对路径；不要直接在用户工作树写入 fixture。

```sh
export QFCA_RELEASE_ROOT="/absolute/path/to/reviewed-qfca"
export QFCA_NPM_CACHE="/absolute/path/to/prepared-npm-cache"
export HOST_REVIEW_ROOT="/absolute/path/to/independent-host-clone"
export FIXTURE_ROOT="$QFCA_RELEASE_ROOT/scripts/release/host-checks"

# npm 脚本会提供 npm_execpath，供离线构建调用已安装 npm。
cd "$HOST_REVIEW_ROOT"
(
  set -eu
  fixture=src/main/qq-modules/release-independent.test.ts
  test ! -e "$fixture"
  cp "$FIXTURE_ROOT/release-independent.fixture" "$fixture"
  trap 'rm -f "$fixture"' EXIT HUP INT TERM
  npm run test -- "$fixture" src/main/qq-modules/package-installation.test.ts
)
```

预期：独立 fixture 19 项；与当前 #344 host 原有 51 项合计 70 项。后续 host 增减原有测试时总数可能变化。

覆盖：实际候选入口/版本、空信任/错误密钥、manifest/签名/载荷篡改、缺/额外文件、时间/host/API/target 边界，以及临时 store 重启读回、防回放、回滚高水位、撤销和过期。
