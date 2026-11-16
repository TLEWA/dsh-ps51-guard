# 更新日志

本项目的重要变更都记录在这里，中英两版同步维护。

## 0.1.0 - 2026-11-16

### 新增

- 建立仓库脚手架：`package.json`、`cordis.patch.yml`、`AGENTS.md`、双语文档与 MIT LICENSE。
- 接入 `TLEWA/dsh-plugin-ci` 统一 CI：verify、`pr-guard`、drift 巡检与 tag 驱动的 release。
- 实现护栏本体：注入 `BASH_ENV` 并链式加载原有值；用 `DEBUG` trap 捕获展开前的 `$BASH_COMMAND`；只在命令最终解析到 PowerShell 5.1 时接管，`pwsh` 与其他插件定义的函数直接放行；区分 bash 与 PowerShell 变量归属（R1）；自动改写 R2–R6（`2>/dev/null`、`export`、`curl`、`Join-Path`、`ls -la`/`rm -rf`）；R7–R10 只提示替代写法；改写时输出 `[ps51] A → B` 注解。
- 常驻 PowerShell 5.1 宿主：命名管道、长度前缀 + JSON 帧；空闲 10 分钟退出、按需重建、崩溃或超时后重启；runspace 内复用，输出按原始字节透传，退出码归一化；含 `exit` 关键字的脚本走一次性进程以保证退出码精确。
- 配置开关 `PS51_GUARD`、`PS51_MODE`、`PS51_STRICT`、`PS51_VERBOSE`、`PS51_DIAGNOSTICS`，以及 JSON 行诊断日志。
- 测试：规则单测、23 条真实命令语料（经 shim 端到端）、200 次宿主稳定性与时延测量；`docs/measurements.md` 记录 M0 基线、时延与退出码语义。

### 说明

- 这是尚未发布的 0.1.0 开发版本；版本号与发布时间由维护者决定。
- 已知限制：绝对路径调用与 `cmd /c` 内的命令无法拦截；`-File` 与 `-EncodedCommand` 原样放行。
