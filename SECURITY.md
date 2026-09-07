# Security Policy

## Supported Version

安全修复优先应用于默认分支和最新 GitHub Release。早期安装包不保证获得单独修复。

## Reporting a Vulnerability

请通过 GitHub 仓库的 **Security > Report a vulnerability** 私下报告。若私密报告功能不可用，请联系仓库维护者，并仅提供复现所需的最少信息。

请勿在公开 Issue 中附带以下内容：

- AI、OCR、Firebase 或 OAuth 凭据
- Android 签名文件或密码
- 完整备份、数据库、日志正文、录音或附件
- 含真实用户标识、同步命名空间或 Provider 原始响应的日志

报告应包含受影响版本、平台、复现步骤、潜在影响和已知缓解方式。维护者确认问题后会协调披露时间；请在修复发布前避免公开细节。

## Deployment Notes

自行部署者必须使用自己的 Firebase/OAuth 配置，部署并验证 `firestore.rules` 与 `storage.rules`，限制客户端 API Key 的 API 和应用来源，并确保 AI/OCR 凭据只保存在本机。仓库中的 Firebase Web 配置不是服务端管理员凭据，但也不能替代正确的安全规则。
