# 测量记录 / Measurements

本文件记录 M0 技术基线与 M2 常驻宿主的实测数据，供后续回归对照。所有数字来自维护者本机，换机器需要重测。
This file records the M0 baseline and the M2 resident-host measurements. Numbers are from the maintainer's machine; re-measure elsewhere.

## 环境 / Environment

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 11（Deskop 位于 OneDrive 同步目录） |
| PowerShell | 5.1.26100.9818，`C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` |
| Node.js | v24.22.1 |
| bash | GNU bash 5.3.20（MSYS2 / Git for Windows） |
| Python | 不涉及 |

## M0：DEBUG trap 拿到的原始命令 Text bash hands the trap

`bash test/probe/trap-probe.sh` 覆盖护栏必须识别的 7 类命令，输出如下（`TRAP_RAW` 行即 `$BASH_COMMAND` 的原文）：

~~~
TRAP_RAW powershell.exe -NoProfile -Command "Write-Output hello"
TRAP_RAW powershell.exe -NoProfile -Command "Get-Item \$env:TEMP"
TRAP_RAW powershell.exe -NoProfile -Command "Write-Output x" 2> /dev/null
TRAP_RAW FOO=bar powershell.exe -NoProfile -Command "Write-Output 1"
TRAP_RAW powershell.exe -NoProfile -Command "Write-Output a"
TRAP_RAW powershell.exe -NoProfile -Command "Write-Output b"
TRAP_RAW echo hi
TRAP_RAW powershell.exe -NoProfile -Command "Write-Output x"
TRAP_RAW powershell.exe -NoProfile -Command 'Write-Output $Y'
TRAP_RAW trap - DEBUG
~~~

结论：
1. `$BASH_COMMAND` 是**展开前**的原文，引号形态、`$var`、重定向都保留，因此 R1 与 R2 只能依赖它，不能依赖函数里的 `$@`（后者已被 bash 展开）。
2. `&&` 会拆成两次 trap（两条 TRAP_RAW），管道两侧各一次；`FOO=bar powershell.exe ...` 整条包含在同一条 TRAP_RAW 里。
3. 探针里的 `\$env:TEMP` 是为了让探针自身不被提前展开；真实命令里写 `$env:TEMP` 时同样会保留在 TRAP_RAW 中。
4. bash 会规范化重定向空格：`2>/dev/null` 变成 `2> /dev/null`，词法分析按此处理。

## M1/M2：时延 / Latency

测量脚本：`libs/ps51-measure.mjs`（工作区临时目录，不进仓），每种场景重复多次后取该次运行的数值。

| 场景 | 每次调用耗时 |
| --- | --- |
| 裸 PowerShell 5.1（无护栏，每次冷启动） | 300–540 ms（多次运行 300–470 ms） |
| 护栏首次调用（bash + node 客户端 + 冷启动宿主） | 约 330 ms |
| 护栏热调用（宿主已就绪，单条命令） | 约 155–165 ms |
| 护栏热调用（同一 bash 会话内 10 条命令均摊） | 约 99–143 ms |
| 宿主内单次 exec（Node 直连管道，200 次，含每请求 runspace 重置、控制台捕获与 stdin 注入） | p50 约 15.3–23.7 ms，p95 约 20.0–28.9 ms，max 约 87.2–99.5 ms |

解读：
- 热路径的固定成本主要是「每条命令一次 `node client.js` 启动 + 一次 bash 启动」；路线图 M2 的 p50 < 120 ms 已达成（按同会话均摊口径）。
- 宿主复用本身仍是毫秒级；每次请求前调用 `ResetRunspaceState()` 隔离变量/函数/偏好，并重定向 `[Console]::Out/Error` 捕获输出，给单次 exec 增加约 20 ms，换来命令之间不串状态。此前不复位时约 2.6–4.0 ms。
- 首次调用必须付一次宿主冷启动（约 0.25–0.3 s），与裸 5.1 的冷启动相同，因此不会比现状更慢。

## pwsh7 重定向 / Redirect

`test/pwsh7.test.mjs` 在与真实使用相同的 shim 上验证（7/7）：

- 默认（`PS51_PWSH7` 未设置）`powershell` 与 `powershell.exe` 都执行 PowerShell 7。
- `PS51_PWSH7=0` 时回到 5.1，并继续由护栏接管。
- `PATH` 中的包装脚本、以及前一个 `BASH_ENV` 已定义的函数保持所有权，不被覆盖。
- 重定向生效时 `lib/index.js` 不预热 5.1 宿主；只有关闭重定向或其他模式需要护栏时才启动，避免留下用不到的 `powershell.exe` 进程。
- 前一个 `BASH_ENV` 如果又 source 回本插件的 shim，`PS51_BASH_ENV_CHAINING` 哨兵会截断循环；该变量不导出，不会传给命令自己的子进程。

## BASH_ENV 竞争与 spawn 注入 / Spawn injection

方案 B 在宿主 `subprocess.spawn` 上包一层，在 spawn 时把本插件的 shim 写进最终 env，因此不再依赖两个插件谁先改 `process.env.BASH_ENV`。`test/subprocess.test.mjs` 覆盖纯函数与生命周期，共 29/29：

- 只处理 `bash -c` 形态，或 env 里已经带有非空 `BASH_ENV` 的 spec；两者都不满足时按原引用返回。省略 env 的 `bash -c` 会从进程环境复制一份，确保 shim 仍能生效；非 bash 且省略 env 时不动。
- spec 里显式写 `BASH_ENV=''` 表示调用方主动关闭，原样尊重；`PS51_GUARD=0` 同样原样返回。
- 原有的 `BASH_ENV`、`PS51_PREV_BASH_ENV`、进程级 ambient 值会按顺序进入生成的 chain 文件，不会丢掉更早的插件；单源时直接复用，不建 chain 文件。
- 不修改传入的 spec 和 env，返回浅拷贝；非目标命令仍以原引用到达原 spawn，this、额外参数、返回值和异常都透传。
- 同一服务重复激活不会二次包装；插件卸载时先让旧 wrapper 透明，再在栈顶时恢复原 spawn 并删除标记。
- 服务冻结、没有 `ctx.inject`、spawn 抛错、cleanup 注册失败都 fail-open，最坏退化为仅靠进程级 `BASH_ENV`。没有 `effect`/`on` 生命周期时回滚包装，避免插件卸载后留下永远生效的 wrapper。
- `PS51_SPAWN_GUARD=0` 可整体关闭注入，用于需要原始 spawn 的宿主。

本机通过假 Cordis 服务加真实 `spawnSync` 验证过：spec 的 `BASH_ENV` 被另一个 shim 覆盖后，最终 spawn 仍拿到本插件 shim，且另一个 shim 经 chain 文件先执行；真实 DSH 重启后的回归验证仍待做。

## 退出码语义 / Exit codes

实测 5.1 的 `-Command` 退出码：`exit 7` → 7；`Write-Error x` → 1；`throw x` → 1；`cmd /c exit 5` → 1；`cmd /c exit 3; echo done` → 0。
宿主内 runspace 无法拿到 `exit` 的退出码（`EndInvoke` 正常返回、`LASTEXITCODE` 仍为 0），因此含 `exit` 关键字的脚本走一次性 spawn；其余脚本在用户脚本后追加一行 `$global:__ps51ExitOk = $?`，执行后从 `SessionStateProxy` 读回，映射 0/1，与 `-Command` 的最终 `$?` 语义一致（`cmd /c exit 5` → 1，`cmd /c exit 3; Write-Output done` → 0）。

## 取消 / Cancellation

宿主在脚本执行期间每 100 ms 用 `PeekNamedPipe` 检查调用方管道；客户端断开（包括 `ops_bash` 取消）时直接退出宿主进程，正在执行的 pipeline 随进程终止，不会在后台继续。`test/host.test.mjs` 用 `Start-Sleep -Seconds 5; Write-Output should-not-run` 验证宿主在 3 秒内退出且 trace 中没有完成记录。

## 输出编码 / Output encoding

5.1 的 stdout 重定向到文件时已经是 UTF-8（`Write-Output`、`cmd /c echo`、`[Console]::Out.WriteLine` 均无 BOM），所以宿主走**字节透传**，不重设编码，避免二次转码破坏中文。
`[Console]::Out/Error` 在宿主内被临时重定向到 `StringWriter` 捕获，再以**原始文本**单独发一帧（不再按行拆分或补 CRLF），因此 `[Console]::Out.Write("a`n`nb")` 的空行与换行形态保持不变；它与 pipeline 输出的相对顺序是近似的（console 文本先发）。

## 复测方式 / How to re-measure

~~~bash
cd dsh-ps51-guard
npm test                    # rules + corpus + host，含 200 次宿主时延
BASH_ENV='' bash test/probe/trap-probe.sh | grep TRAP_RAW
~~~
