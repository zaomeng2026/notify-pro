# ALIGNMENT_自研APK

## 原始需求

- 按 6A 工作流，逐步落地“自研 APK”。
- 当前电脑没有本地 Android 打包环境。
- 目标是先高效打出可安装 APK，再迭代功能。

## 任务边界

- 本次只交付最小可运行 Android 工程骨架与云打包链路。
- 不包含完整商用功能（如离线队列持久化、远程更新、崩溃上报）。

## 验收标准

- 仓库内存在标准 Android 工程结构。
- GitHub Actions 可手动触发 debug 打包。
- 若配置签名 secrets，可触发 release 打包。
