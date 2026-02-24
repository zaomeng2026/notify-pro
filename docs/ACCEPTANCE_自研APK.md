# ACCEPTANCE_自研APK

## 执行结果

- [x] 生成 Android 工程骨架（Kotlin / AGP 8 / SDK 34）。
- [x] 完成基础配置页（base URL 保存、权限入口）。
- [x] 完成通知监听服务（微信/支付宝过滤、关键字过滤、5 秒去重）。
- [x] 完成 API 对接（health / auto-claim / notify / ping）。
- [x] 完成 GitHub Actions debug/release 工作流。
- [x] 完成无本地环境打包文档。

## 待补项（下一阶段）

- [ ] 本地离线队列持久化（SQLite/Room）。
- [ ] 完整后台保活策略（前台服务 + 引导页）。
- [ ] 应用内更新（版本检测 + 下载升级）。
- [ ] 崩溃日志回传与诊断。
