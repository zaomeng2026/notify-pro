# notify-pro

收款数据同步大屏（商业版）项目。

## 功能

- 微信/支付宝收款通知同步到电脑端
- 大屏实时展示与后台配置
- 手机配对（二维码）与设备在线状态
- Android 自研监听端（NotificationListenerService）

## 本地启动（Node 服务）

```bash
npm install
npm start
```

- 展示页：`http://localhost:3180/`
- 后台：`http://localhost:3180/admin`

## Android 工程

- `app/`：Android 客户端源码
- `.github/workflows/android-debug.yml`：GitHub Actions 云编译 Debug APK
- `.github/workflows/android-release.yml`：GitHub Actions 云编译 Release APK（需签名密钥）

