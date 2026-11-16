# 更新日志

本项目的重要变更都记录在这里，中英两版同步维护。

## 0.1.0 - 2026-11-16

### 新增

- 建立仓库脚手架：`package.json`、`cordis.patch.yml`、`AGENTS.md`、双语文档与 MIT LICENSE。
- 接入 `TLEWA/dsh-plugin-ci` 统一 CI：verify、`pr-guard`、drift 巡检与 tag 驱动的 release。
- 迁移 `dsh-ps51-guard` 开发路线图到维护者本地工作区（`ROADMAP.md` 已 gitignore，不进仓、不随包发布）。

### 说明

- 插件本体尚未实现；`lib/index.js` 只保留 Cordis `apply` 契约，用于验证 manifest、打包与 CI 接线。
