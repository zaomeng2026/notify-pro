# CONSENSUS_自研APK

## 共识结论

- 采用 `Kotlin + 原生 NotificationListenerService` 作为长期方案。
- 短期使用 GitHub Actions 云打包，避免本地环境阻塞。
- 功能先做最小闭环：
  - 配置服务器地址
  - 自动认领配置（`/api/pairing/auto-claim`）
  - 监听微信/支付宝通知并上报
  - 心跳上报在线状态

## 技术约束

- Android `minSdk=26`，`targetSdk=34`。
- JDK 17 + AGP 8.x。
- 网络传输先用 `HttpURLConnection`（减少依赖）。
