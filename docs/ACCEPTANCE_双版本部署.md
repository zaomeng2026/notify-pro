# ACCEPTANCE_双版本部署

## 执行结果

- [x] 已新增 6A 文档：
  - `docs/ALIGNMENT_双版本部署.md`
  - `docs/CONSENSUS_双版本部署.md`
  - `docs/DESIGN_双版本部署.md`
  - `docs/TASK_双版本部署.md`
- [x] 已实现双模式运行骨架：
  - `DEPLOY_MODE=lan|cloud`
  - 云模式强制校验 `PUBLIC_BASE_URL`（默认）
  - 云模式强制校验 `MYSQL_URL`（默认）
- [x] 已补充部署资产：
  - `.env.lan.example`
  - `.env.cloud.example`
  - `deploy/baota/*`
  - `docs/BAOTA_部署指南_双版本.md`
- [x] 已补充启动入口：
  - `bootstrap.js`
  - `npm run start:lan`
  - `npm run start:cloud`

## 验证记录

- 语法检查：
  - `node --check server.js` 通过
  - `node --check bootstrap.js` 通过
- 启动验证：
  - LAN 模式可启动（随机端口验证通过）
  - CLOUD 模式缺少 `PUBLIC_BASE_URL` 会按预期失败
  - CLOUD 模式缺少 `MYSQL_URL` 会按预期失败
  - CLOUD 模式关闭强校验时可本地调试启动

## 未覆盖项

- 多租户 SaaS 业务逻辑尚未落地（仅完成 SQL 草案与架构文档）。
- Android 客户端当前仍按单租户 API 通信，尚未接入租户登录流程。
