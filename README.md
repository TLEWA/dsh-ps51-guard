# dsh-ps51-guard

> 状态：0.1.0，M1–M5 已实现。为通过 `ops_bash` 调用的 **Windows PowerShell 5.1** 提供命令传输保护、语法兼容改写与执行结果归一化，并内置可关闭的 `powershell → pwsh 7` 重定向。

DSH 的 `ops_bash` 用 bash 执行命令，而 Windows 上的 `powershell`/`powershell.exe` 是 5.1。命令从模型到 PowerShell 要穿过 bash 的引号与变量展开，5.1 又缺少 PowerShell 7 的语法与编码选项，于是出现「引号被吃掉」「`$env:TEMP` 变成 `:TEMP`」「`2>/dev/null` 报错」「错误退出码为 0」等问题。本插件在 bash 进程内接管最终解析到 5.1 的调用，在命令到达 PowerShell 之前完成纠正。

从 0.2 里程碑起，本插件同时内置原先由 `dsh-pwsh7-bash` 提供的 `powershell → pwsh 7` 重定向，默认开启；需要 5.1 时设 `PS51_PWSH7=0`。迁移后应移除旧插件，避免两个插件争抢 `BASH_ENV`。

## 工作方式

1. 插件在 DSH 进程内把 `BASH_ENV` 指向自带的 `bash-env.sh`，并链式加载原有 `BASH_ENV`（若已被其他插件设置），互不覆盖。
2. shim 先按 `PS51_PWSH7` 决定是否安装 `powershell → pwsh 7` 函数；默认把解析到 5.1 的 `powershell`/`powershell.exe` 转给 `pwsh`。随后用 bash 的 `DEBUG` trap 读取 `$BASH_COMMAND` 原文（尚未被展开），只在命令词最终是 5.1 且未被重定向时启用 5.1 护栏；同时导出 bash 变量名清单，供判断 `$name` 归属。
3. `lib/client.js` 解析原文、按 argv 恢复被 bash 展开的值、套用改写规则，然后把命令交给常驻宿主。
4. 常驻 PowerShell 5.1 宿主（命名管道、4 字节小端长度前缀 + JSON 帧）执行命令；stdout/stderr 以**原始字节**回传（含 `[Console]::Out/Error` 的输出），stdin 通过 `[Console]::In` 提供给脚本，退出码取脚本最后一条命令的 `$?`，与 `-Command` 一致。连接阶段宿主不可用时回退到原始调用；请求已经发出后的宿主故障只报错退出（退出码 125）而不重放，任何情况下都不会执行两次。客户端断开或 `ops_bash` 被取消时，宿主会在 100 毫秒内发现并退出，正在执行的长命令不会在后台继续跑完。

## 接管范围

- 默认把 `powershell` / `powershell.exe` 重定向到 `pwsh 7`；`PS51_PWSH7=0` 时改为对解析到 5.1 的调用启用护栏。
- 重定向与护栏都只在命令词最终解析到 5.1（或命令尚不存在）且 `command -v` 结果与已知 5.1 路径一致时安装；`PATH` 中的包装脚本、别名、其他插件或用户已定义的函数不覆盖。
- `pwsh` 直接放行；绝对路径调用（`/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ...`）与 `cmd /c` 内的调用无法拦截，这是路线图记录在案的已知限制。

## 规则

| 规则 | 触发 | 行为 |
| --- | --- | --- |
| R1 | `-Command` 双引号内的 `$name` | bash 变量按 bash 展开；PowerShell 变量（`$env:TEMP` 等）保留字面量 |
| R2 | `2>/dev/null` | 改写为 `2>$null` |
| R3 | `export FOO=bar` | 改写为 `$env:FOO = 'bar'` |
| R4 | `curl ` | 改写为 `curl.exe `（避开 PowerShell 别名） |
| R5 | `Join-Path a b c` | 改写为嵌套 `Join-Path (Join-Path a b) c` |
| R6 | `ls -la`、`rm -rf` | 改写为 `Get-ChildItem -Force`、`Remove-Item -Recurse -Force` |
| R7 | `-Encoding utf8NoBOM` | 只提示（5.1 的参数集不接受该值） |
| R8 | PowerShell 内 `> file` | 只提示（5.1 写出 UTF-16LE BOM；需要无 BOM 时用 .NET 接口） |
| R9 | `&&`、`||` | 只提示替代写法 `a; if ($?) { b }` |
| R10 | `??`、`?:` | 只提示等价的 `if/else` 写法 |

改写时会在 stderr 打印 `[ps51] A → B`，让模型知道命令被调整过。高风险规则（R7–R10）与 R8 的错误只在必要时提示。

## 配置

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PS51_GUARD` | `1` | 设为 `0` 完全关闭护栏与重定向，恢复原始调用 |
| `PS51_PWSH7` | `1` | 设为 `0` 关闭 `powershell → pwsh 7` 重定向，保留 5.1 护栏 |
| `PS51_PWSH7_PATH` | 自动探测 | 指定 `pwsh.exe` 的路径 |
| `PS51_MODE` | `rewrite` | `annotate` 只提示不改写；`off` 直接放行 |
| `PS51_STRICT` | `0` | 设为 `1` 时，命中只提示规则（R7–R10）的命令以退出码 2 拦下 |
| `PS51_VERBOSE` | `0` | 设为 `1` 时输出全部提示，包括 R8 等低优先级说明 |
| `PS51_DIAGNOSTICS` | `1` | 设为 `0` 停止写诊断日志 |

`PS51_GUARD` 与 `PS51_PWSH7` 在 DSH 进程启动时读取，修改后需重启 DSH。诊断日志写在 `%TEMP%\dsh-ps51-guard-<用户名>\session-<pid>\diagnostics.log`（JSON 行，含命中的规则与改写前后命令），排查完建议关闭。设置 `PS51_TRACE=1` 可以让宿主额外写 `host-trace.log`。

## 已知限制

- 重定向在 bash 启动时安装为函数；`command powershell`、绝对路径和 `cmd /c` 不经过重定向，仍会执行 5.1（也不经过护栏）。
- 重定向开关在 DSH 启动时读取；shell 启动后已安装的函数不会因单条命令前缀 `PS51_PWSH7=0` 而改变。需要 5.1 时请在启动 DSH 前设置并重启。
- 只处理 `-Command` / `-c` 载荷；`-File` 与 `-EncodedCommand` 原样放行，不做改写。
- 含 `exit` 关键字的脚本走一次性进程（约 0.3–0.5 秒），因为 runspace 拿不到 `exit` 的退出码。
- 每条命令要启动一次 `node` 客户端；宿主复用后同会话均摊约 100 毫秒/条，仍高于裸 5.1 的热执行。
- bash 与 PowerShell 同名变量同时出现时按 argv 已展开值处理，并标记 `mixed-variables`，可能不是模型的本意。
- 请求已交给宿主后若宿主崩溃或断开，客户端以 125 退出且不重放命令；只有尚未发出请求的连接失败才会回退到原命令。
- stdin 只暴露给 `[Console]::In`；宿主派生的原生子进程仍然拿到关闭的 stdin。
- `[Console]::Out/Error` 按原始字节单独回传，与 PowerShell pipeline 输出的相对顺序是近似的（console 文本先于格式化后的 pipeline 输出）。
- 退出码取脚本最后一条命令的 `$?`；`-ErrorAction SilentlyContinue` 之类吞掉错误时，即使有错误也可能返回 0。
- 取消时宿主直接退出以停止 pipeline；由脚本启动的原生子进程不保证一并终止。

## 开发

```bash
npm test
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
```

测试包含规则单测、33 条真实命令语料（经 shim 端到端跑）与 200 次宿主稳定性/时延测量。技术基线与测量数据见 [docs/measurements.md](./docs/measurements.md)。

## 我的其他 DSH 项目

- [dsh-better-choice](https://github.com/TLEWA/dsh-better-choice) — 选择题备注与旁问
- [dsh-fastload](https://github.com/TLEWA/dsh-fastload) — 长会话首屏历史瘦身
- [dsh-if](https://github.com/TLEWA/dsh-if) — `/if` 条件指令
- [dsh-opencode-go-router](https://github.com/TLEWA/dsh-opencode-go-router) — OpenCode Go 路由 id 保温与轮换
- [dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer) — 七区域布局拖拽整理
- [dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu) — 侧栏右键菜单与打开方式
- [dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output) — Windows 子进程 GBK/CP936 乱码修复
- [dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs) — PTC `run_code` 无参工具调用归一化

## 许可

MIT，见 [LICENSE](./LICENSE)。
