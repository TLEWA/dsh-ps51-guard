# dsh-ps51-guard

> 状态：脚手架阶段（0.1.0）。插件本体尚未实现；开发路线图 `ROADMAP.md` 只保留在维护者本地工作区（已 gitignore），不随仓库分发。

为通过 `ops_bash` 调用的 **Windows PowerShell 5.1** 提供命令传输保护、兼容性改写与执行结果归一化，减少引号、编码和语法差异引发的失败与重试。

## 它解决什么问题

| 类别 | 现状 | 目标 |
| --- | --- | --- |
| 命令传输 | 命令经 bash 展开后，引号与 `$` 可能被提前消耗 | 用 UTF-16LE 的 `-EncodedCommand` 传输命令 |
| 语法兼容 | PowerShell 7 写法在 5.1 上直接报错 | 按已验证规则改写；高风险写法只给替代方案 |
| 执行反馈 | 错误被成功退出码或乱码掩盖 | 统一退出码与输出编码，交给现有输出插件处理乱码 |

## 当前状态

本仓库目前只有外围组件：包清单、bundle patch、统一 CI 接线、双语文档与路线图。`lib/index.js` 是占位入口，只保留 Cordis 的 `apply` 契约，好让 manifest、打包与 CI 检查可以真实运行。

## 计划中的能力

- **按可执行文件接管**：只接管最终解析到 PowerShell 5.1 的命令；`pwsh`、其他插件设置的 `powershell` 函数与未知路径一律放行。
- **常驻宿主**：PowerShell 5.1 冷启动约 200–800ms，首期即交付常驻宿主以压低调用延迟，宿主不可用时降级为一次性进程。
- **规则与提示**：R1–R10 覆盖 `2>/dev/null`、`export`、`curl`、`Join-Path`、`ls -la` 等已知差异；`&&`、`||`、`??` 只提示替代写法，不自动改写。

## 配置（预留）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PS51_GUARD` | `1` | 设为 `0` 完全关闭护栏，恢复原始调用 |
| `PS51_MODE` | `rewrite` | 设为 `annotate` 时只提示、不改写 |

上述变量在 M1/M3 落地后才真正生效；当前版本读取它们不会改变任何行为。

## 开发

```bash
npm test
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
```

## 路线图

里程碑、验收条件与风险记录在维护者本地的 `ROADMAP.md`（不进仓、不发布）。M0 技术基线已完成大部分；M1 起才动插件本体。

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
