# GitHub APK 打包说明

## 目标

- 使用 GitHub Actions 打包 APK，不依赖本机 Android SDK。

## Debug 包（推荐日常）

触发方式：

1. 推送到 `main` 分支（自动触发）。
2. 或进入仓库 `Actions -> Android Debug APK -> Run workflow` 手动触发。

产物位置：

- 构建完成后在该次 workflow 的 `Artifacts` 下载 `app-debug-apk`。

## Release 包

触发方式：

- 推送 tag，例如：`v1.0.1`。

前置 secrets（仓库 Settings -> Secrets and variables -> Actions）：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

产物位置：

- `Artifacts` 下载 `app-release-apk`。

## 本次改动对云端打包影响

- 仅修改 Android 源码与资源，不依赖本地 SDK。
- 本地无法编译不会影响 GitHub 云端编译流程。
