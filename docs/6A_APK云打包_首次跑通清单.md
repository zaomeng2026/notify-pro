# 6A APK 云打包首次跑通清单

## 1. Align（目标对齐）

- 目标：你电脑不装 Android 打包环境，也能产出 APK。
- 首次目标：先跑通 `Debug APK`（不依赖签名），再上 `Release APK`。
- 验收：GitHub Actions 里能下载 `app-debug-apk`。

## 2. Architect（方案）

- 方案：GitHub Actions。
- 已提供工作流：
  - `.github/workflows/android-debug.yml`
  - `.github/workflows/android-release.yml`

## 3. Atomize（拆解）

### 3.1 首次跑通（Debug）

1. 把 Android 项目推到仓库（至少要有 `gradlew` 和 `app` 目录）。
2. 如果电脑提示 `git 不是内部或外部命令`：
- 方案 A：安装 `Git for Windows`
- 方案 B：安装 `GitHub Desktop`，用图形界面提交并推送
3. 打开 GitHub 仓库 -> `Actions`。
4. 选择 `Android Debug APK`。
5. 点击 `Run workflow`。
6. 运行结束后在 `Artifacts` 下载 `app-debug-apk`。

### 3.2 正式发布（Release）

1. 仓库设置 -> `Settings` -> `Secrets and variables` -> `Actions`。
2. 添加 4 个 secrets：
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
3. 手动触发 `Android Release APK` 或推 tag：

```bash
git tag v1.0.0
git push origin v1.0.0
```

4. 下载 `app-release-apk`。

## 4. Approve（检查点）

- Debug 构建成功后再做 Release。
- Release 失败优先检查 4 个 secrets 是否拼写一致。
- 同一应用后续升级必须使用同一个 keystore。

## 5. Automate（自动化）

- 日常开发：每次提交后手动触发 `Android Debug APK` 验证。
- 发版：打 tag 自动触发 `Android Release APK`。

## 6. Assess（评估）

- 通过标准：
  - Debug APK 可安装。
  - Release APK 可安装并覆盖升级。
  - 版本号正确。

- 后续增强建议：
  1. 增加 `beta` 分支自动构建。
  2. 增加版本说明自动生成。
  3. 增加崩溃日志回传。
