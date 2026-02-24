# 6A 无本地环境 APK 打包方案

## 1. Align（对齐）

- 目标：在电脑无 Android 打包环境（无 Android Studio/SDK）的前提下，完成 APK 云端打包。
- 约束：
  - 本地只做代码编辑与提交。
  - 打包、签名、产物下载全部在云端完成。
- 验收标准：
  - 提交标签后自动生成 `release APK`。
  - 可在 GitHub Actions 里下载 APK 产物。
  - 支持后续版本持续更新（同一签名密钥）。

## 2. Architect（架构）

- 推荐主方案：`GitHub Actions` 云打包（成本低、可控、通用）。
- 备选方案：`Codemagic`（UI 友好，但长期成本可能更高）。
- 核心链路：
  - 本地编辑代码 -> Push 到 GitHub
  - GitHub Runner 执行 `./gradlew assembleRelease`
  - 产物通过 artifact 输出供下载

## 3. Atomize（原子化任务）

1. 建 GitHub 仓库并推送 Android 项目代码。
2. 准备签名密钥（`keystore`）。
3. 把签名信息放进 GitHub Secrets。
4. 添加工作流文件（见下文模板）。
5. 推送 tag 触发打包。
6. 下载产物并安装测试。

## 4. Approve（风险审查）

- 风险1：签名密钥丢失，后续无法平滑升级。
  - 对策：离线双备份（U盘 + 加密网盘）。
- 风险2：CI 打包成功但 APP 崩溃。
  - 对策：每次 Release 至少 1 台真机烟测。
- 风险3：Secrets 配置错误导致签名失败。
  - 对策：先跑 `debug` 构建，再切 `release` 签名构建。

## 5. Automate（自动化执行）

### 5.1 GitHub Secrets（必须）

- `ANDROID_KEYSTORE_BASE64`：keystore 文件的 Base64 内容
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

### 5.2 工作流文件（示例）

- 文件路径：`.github/workflows/android-release.yml`
- 触发方式：推送 tag（例如 `v1.0.0`）

```yaml
name: Android Release APK

on:
  push:
    tags:
      - "v*"

jobs:
  build-release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup JDK
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
          cache: gradle

      - name: Restore keystore
        run: |
          echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > app/release.keystore

      - name: Build release
        run: |
          chmod +x gradlew
          ./gradlew assembleRelease \
            -Pandroid.injected.signing.store.file=app/release.keystore \
            -Pandroid.injected.signing.store.password=${{ secrets.ANDROID_KEYSTORE_PASSWORD }} \
            -Pandroid.injected.signing.key.alias=${{ secrets.ANDROID_KEY_ALIAS }} \
            -Pandroid.injected.signing.key.password=${{ secrets.ANDROID_KEY_PASSWORD }}

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: app-release-apk
          path: app/build/outputs/apk/release/*.apk
```

### 5.3 触发构建

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 5.4 下载 APK

- 进入 GitHub 仓库 -> `Actions` -> 对应工作流运行 -> `Artifacts` 下载。

## 6. Assess（评估）

- 通过标准：
  - CI 构建成功。
  - APK 可安装。
  - 核心流程（通知监听 -> 上报 -> 大屏显示）可用。
- 下一步：
  1. 增加 `beta` 分支自动构建 debug 包。
  2. 增加发布说明和版本号自动写入。
  3. 增加崩溃日志上报与远程诊断。

## 附：无本地环境时最省事的实践

- 开发代码：本地任意编辑器即可。
- 打包签名：全部交给 GitHub Actions。
- 测试：真机直接装 CI 产物。
- 分发：先用私有下载链接，后续再接入应用更新服务。
