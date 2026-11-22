# 更新日志

本项目的重要变更都记录在这里，中英两版同步维护。

## [Unreleased]

### 修复

- 取消识别同时接受新旧两代宿主的取消码，且不判断宿主版本。rc.5 把中止报告为 `AbortError`；alpha 的 `dsh-tools` 把「调用方已中止、错误本身未被分类」的失败改标为 `{ name: 'AbortError', code: state.bodyInvoked ? 'ABORTED' : 'ABORTED_BEFORE_DISPATCH' }`（`dsh-tools/src/pipeline.ts:335,339-345`，错误体把这对值放在 `error.info` 里）。新增 `lib/cancellation.js` 按名字/码集合匹配：`ABORT_ERR`、`ABORTED`、`ABORTED_BEFORE_DISPATCH` 与 `AbortError` 名（含 `error.info` 包裹形状）都归为取消，匹配顺序为自身 `code` → `info.code` → 自身 `name` → `info.name` → `cause` 链（最多 4 层）→ `signal.reason` → `signal.aborted`，大小写不敏感但只认已知值。
- 只放宽匹配，不改分支语义：取消仍以退出码 125 结束、仍不重放命令、仍不回退到原命令；`lib/client.js` 只是把诊断 `kind` 分成 `host-cancelled` 与 `host-failed`，前者文案为 `[ps51] cancelled while the resident host was running; …`，后者的文案与 rc.5 逐字相同（`[ps51] resident host failed after the command was sent and was not retried: …`）。`main()` 的内部错误出口同样区分取消与内部错误，退出码保持 1。
- 明确取消码的可达范围：`ABORTED` 系列码只在 DSH 主进程里生成，而 Windows 上的真实 `ops_bash` 取消以 `TerminateJobObject` 终止整棵 bash 作业（`dsh-subprocess-local/lib/runner.js:280`），本插件客户端没有机会执行上报代码，因此不会打印 `[ps51] cancelled`、也不会写诊断——真实取消由 DSH 自己报告，宿主在客户端断开时停止 pipeline（`host/ps51-host.ps1`）。这次放宽是防御性的：一旦错误对象真的带着取消形状到达客户端（包括 `cause` 链与 `signal.reason`），它会走取消分支而不是被误报成宿主失败；传输/帧/启动失败仍记为 `host-failed`。
- 测试扩到 10 条：新增「客户端真实捕获的传输/帧错误形状」「`cause` 链与 `signal.reason`」两组单测，以及「真宿主 + 真客户端进程树被整树终止时宿主停止、命令不重放」的端到端用例；`npm test`、`npm run check` 均已接入。

## 0.1.0 - 2026-11-16

### 新增

- 建立仓库脚手架：`package.json`、`cordis.patch.yml`、`AGENTS.md`、双语文档与 MIT LICENSE。
- 接入 `TLEWA/dsh-plugin-ci` 统一 CI：verify、`pr-guard`、drift 巡检与 tag 驱动的 release。
- 实现护栏本体：注入 `BASH_ENV` 并链式加载原有值；用 `DEBUG` trap 捕获展开前的 `$BASH_COMMAND`；只在命令最终解析到 PowerShell 5.1 时接管，`pwsh` 与其他插件定义的函数直接放行；区分 bash 与 PowerShell 变量归属（R1）；请求携带调用方的 stdin（脚本可从 `[Console]::In` 读取），环境按请求完整快照还原（调用方 unset 的变量也会从宿主删除）；自动改写 R2–R6（`2>/dev/null`、`export`、`curl`、`Join-Path`、`ls -la`/`rm -rf`）；R7–R10 只提示替代写法；改写时输出 `[ps51] A → B` 注解。
- 常驻 PowerShell 5.1 宿主：命名管道、长度前缀 + JSON 帧；空闲 10 分钟退出、按需重建、崩溃或超时后重启；runspace 内复用，输出按原始字节透传（`[Console]::Out/Error` 单独按原始字节回传），退出码取脚本最终 `$?`；客户端断开或取消时宿主中止执行并退出；含 `exit` 关键字的脚本走一次性进程以保证退出码精确。
- 合并原先由 `dsh-pwsh7-bash` 提供的 `powershell → pwsh 7` 重定向：默认开启，`PS51_PWSH7=0` 关闭，`PS51_PWSH7_PATH` 可指定 `pwsh.exe`；只接管最终解析到 5.1（或命令尚不存在）的命令词，已有函数、别名和 `PATH` 包装器不覆盖；`PS51_GUARD=0` 同时关闭护栏与重定向。
- 修复重定向函数在 `eval` 源码里直接拼接 pwsh 路径的问题：现在通过 `__ps51_pwsh7` 变量调用，路径包含 `$` 或反引号时不会被展开或执行；新增回归测试。
- 配置开关 `PS51_GUARD`、`PS51_PWSH7`、`PS51_PWSH7_PATH`、`PS51_MODE`、`PS51_STRICT`、`PS51_VERBOSE`、`PS51_DIAGNOSTICS`、`PS51_SPAWN_GUARD`，以及 JSON 行诊断日志。
- 增加 `subprocess.spawn` 注入（`PS51_SPAWN_GUARD=1` 默认开启）：在 spawn 时把 shim 写入最终环境，并链式保留该环境里已有的 `BASH_ENV`，解决另一个插件在本插件之后覆盖进程级 `BASH_ENV` 导致护栏失效的问题；显式空 `BASH_ENV` 与 `PS51_GUARD=0` 仍被尊重。新增 29 条桥接单测（链文件、路径等价、spawn 包装生命周期与卸载透明性）。
- 测试：规则单测、33 条真实命令语料（经 shim 端到端）、8 条重定向集成测试（含路径元字符回归）、200 次宿主稳定性与时延测量；`docs/measurements.md` 记录 M0 基线、时延与退出码语义。

### 说明

- 这是尚未发布的 0.1.0 开发版本；版本号与发布时间由维护者决定。
- 迁移：desktop profile 改用本插件后应移除并删除 `dsh-pwsh7-bash`，避免两个 `BASH_ENV` 提供者互相覆盖。
- 已知限制：绝对路径调用与 `cmd /c` 内的命令无法拦截；`-File` 与 `-EncodedCommand` 原样放行；重定向在 bash 启动时安装，`command powershell` 与绝对路径不经过它。
