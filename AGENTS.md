# AGENTS.md

本仓库是一个 DSH 插件。开工前先读仓库的 `README.md`；开发路线图 `ROADMAP.md` 在仓库根但已 gitignore，只存在于维护者本地。通用流程与检查项看中心仓的 [PROCESS.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/PROCESS.md) 与 [docs/gates.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/docs/gates.md)。本文件只强调本类仓库最容易出错的点。

## 插件的硬性约束

- `package.json` 必须有顶层 `engines.dsh` 与 `engines.node`；写在 `dsh.engines.dsh` 会被宿主忽略。
- `dsh.manifestVersion` 必须是 1，`dsh.bundle.patch` 必须指向真实存在的 `cordis.patch.yml`。
- `cordis.patch.yml` 里 `insert[].name` 必须等于包名；`id` 是用户可见的短名（`ps51-guard`），不要随意改。
- `lib/` 是直接运行的源码（本仓库没有构建步骤）；不要新增 build 步骤，也不要把 `lib/*.js` 改成生成物。
- `package.json` 的 `scripts.prepublishOnly` 必须调用 `dsh-ci-gate --prepublish`；它拦截本机 `npm publish`，不要删除或绕过。

## 当前阶段：只有外围组件

本仓库目前是脚手架，**插件本体尚未实现**。`lib/index.js` 是占位入口，只保留 Cordis 的 `apply` 契约，让 manifest、`npm pack` 与 CI 检查能真实运行；`test/smoke.test.mjs` 只验证契约与清单一致。

- 在 M1 开始前，不要往 `lib/` 里塞 shim、lexer、client 或宿主脚本；插件行为一律以 `ROADMAP.md` 的里程碑为准。
- `ROADMAP.md` 是决策与验收条件的唯一事实源，但它不进仓：已写入 `.gitignore`（`/ROADMAP.md`），不要 `git add -f`，不要提交回仓库，也不要让 README 或 CHANGELOG 依赖它的链接。
- 改方案先改路线图，再改代码；路线图缺失时（例如在干净 clone 里）先向维护者索要，不要凭记忆补写。
- 决策 D1–D5（不新增模型可见工具、首期交付常驻宿主、不覆盖既有 `powershell` 重定向、仅对 PowerShell 5.1 生效、默认改写并标注）未经用户确认不得推翻。

## 每次改动

1. 从最新 main 开 `feat/`、`fix/`、`docs/` 或 `chore/` 分支。
2. 改代码、测试、双语文档与 CHANGELOG（同一个 PR）。
3. 本地跑 gate，全绿再 push；不要复制 gate 脚本，CI 会通过 `.ci` 运行中心仓的版本。
4. 开 PR 并按模板勾选；`ci / ci-ok` 与 `pr-guard / guard` 通过后由维护者合并。改 CI、AGENTS 或 PR 模板必须加 `ci-change`；`human-approved` 只能由人加。

```bash
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
npm test
```

## 发布

只由维护者打 tag 触发 `release.yml`。模型不得执行 `npm publish`、不得改版本号（除非在 `release/` 分支上且被明确要求）。

<!-- dsh-review-policy:v1:start -->
## Code Review Rules

- 用中文报告可证明的严重缺陷，写清触发条件、实际影响和最小相关代码位置；避免风格建议及重复 CI 已完成的机械检查。未返回审阅结果不表示通过。
- 检查宿主兼容性与用户数据边界：插件不得意外改变非目标请求、消息、配置或持久化数据；判断影响时遵守本仓明确记录的兼容例外。
- 检查异常、取消、卸载与重复初始化路径：钩子、监听器和共享状态应正确清理；失败回退不得造成重复执行、数据丢失或泄漏敏感信息。
- 审阅只发表意见。不得自动修复、添加人工批准标签、合并、改版本或发布；保留现有 CI 与人工批准流程。
<!-- dsh-review-policy:v1:end -->

### 本仓审阅重点

- 只在最终解析到 PowerShell 5.1 时接管，`pwsh` 与其他插件设置的 `powershell` 函数不得被覆盖；内部异常必须 fail-open，回退到原命令且不重复执行。
