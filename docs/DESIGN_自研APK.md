# DESIGN_自研APK

## 架构

```mermaid
flowchart LR
  A[MainActivity] --> B[ConfigStore]
  C[NotifyListenerService] --> B
  C --> D[NotifyApi]
  D --> E[/api/pairing/auto-claim]
  D --> F[/api/notify]
  D --> G[/api/device/ping]
```

## 模块说明

- `MainActivity`：输入/保存 base URL，指导开启权限。
- `ConfigStore`：持久化 base/api/token/deviceId。
- `NotifyListenerService`：监听通知、去重、上报、心跳。
- `NotifyApi`：HTTP 封装（health/claim/notify/ping）。

## 异常策略

- 认领失败：后台定时重试，不崩溃。
- 上报失败：当前骨架仅日志记录，后续补本地队列。
