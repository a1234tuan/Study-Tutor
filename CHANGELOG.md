# Changelog

本项目遵循语义化版本的方向记录公开发布变化。开源前的内部阶段记录保留在 `docs/`。

## [0.2.3] - 2026-09-07

首个公开源码快照。

### Added

- 本地优先的学习日志、富文本和结构化内容编辑。
- 轻回看与 FSRS 记忆卡复习流程。
- 基于决策块的 AI 学习助教、自适应训练与延迟验证。
- 可选 Google 登录与 Firebase 增量云同步。
- 完整 ZIP 备份、Android 增量文件夹备份、OCR、录音和知识播客。
- “温润阅读”和“清爽现代”双视觉主题，以及独立浅色/深色模式。

### Reliability

- schema 19 迁移、同步墓碑、内容冲突归档和隐私导出边界。
- 大日志库分页/增量呈现、移动端编辑工具分组、系统返回和遮挡回归保护。
- 119 个 Vitest 文件（796 项测试）、30 个跨视口 Playwright 场景和 3 个 Firebase Emulator 场景。

### Packages

- Android：`versionName 0.2.3`，`versionCode 14`。
- Windows：`0.1.6`。

### Known release gates

- 真实 Android 设备上的中文 IME、系统返回、前后台和覆盖升级仍需逐设备人工验收。
- 真实 Firebase 账号的 reads/writes、Storage 和账单指标仍需受控验收。
- Windows 安装包尚未使用商业 Authenticode 证书。
