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
| 宿主内单次 exec（Node 直连管道，200 次） | p50 2.6–4.0 ms，p95 3.5–5.5 ms，max 58–75 ms |

解读：
- 热路径的固定成本主要是「每条命令一次 `node client.js` 启动 + 一次 bash 启动」，宿主复用只占个位数毫秒；路线图 M2 的 p50 < 120 ms 已达成（按同会话均摊口径）。
- 首次调用必须付一次宿主冷启动（约 0.25–0.3 s），与裸 5.1 的冷启动相同，因此不会比现状更慢。
- 宿主 p50 的抖动来自 Windows 调度；max 接近 75 ms 是首次 JIT/加载模块的开销。

## 退出码语义 / Exit codes

实测 5.1 的 `-Command` 退出码：`exit 7` → 7；`Write-Error x` → 1；`throw x` → 1；`cmd /c exit 5` → 1；`cmd /c exit 3; echo done` → 0。
宿主内 runspace 无法拿到 `exit` 的退出码（`EndInvoke` 正常返回、`LASTEXITCODE` 仍为 0），因此含 `exit` 关键字的脚本走一次性 spawn；其余脚本按 `$?` 映射 0/1，与 `-Command` 语义一致。

## 输出编码 / Output encoding

5.1 的 stdout 重定向到文件时已经是 UTF-8（`Write-Output`、`cmd /c echo`、`[Console]::Out.WriteLine` 均无 BOM），所以宿主走**字节透传**，不重设编码，避免二次转码破坏中文。

## 复测方式 / How to re-measure

~~~bash
cd dsh-ps51-guard
npm test                    # rules + corpus + host，含 200 次宿主时延
BASH_ENV='' bash test/probe/trap-probe.sh | grep TRAP_RAW
~~~
