# ACCEPTANCE_移动端审查与UI重构

## 审查结论

### 发现的问题

1. 高风险一致性问题：设置了后台密码后，App 保存设置会失败。  
- 位置：`app/src/main/java/com/notifypro/mobile/NotifyApi.kt`（旧实现 `saveSettings` 未传 `X-Admin-Password`）。

2. 中风险一致性问题：服务端已支持备份参数，App 未提供读取/保存入口。  
- 位置：`app/src/main/java/com/notifypro/mobile/NotifyApi.kt`、`app/src/main/java/com/notifypro/mobile/MainActivity.kt`。

3. 中风险 UX 问题：单页堆叠过长，关键操作与状态混杂，误操作成本高。  
- 位置：`app/src/main/res/layout/activity_main.xml`（旧版）。

## 已完成修复

- [x] `NotifyApi.saveSettings` 新增管理员密码头透传。
- [x] `ConfigStore` 新增管理员密码持久化。
- [x] `ShopSettings` 模型新增 `backupKeep`、`autoDailyBackupHour`。
- [x] `MainActivity` 新增管理员密码/备份参数读写与保存。
- [x] `activity_main.xml` 重构为卡片分区式移动端布局，并二次打磨：
  - 操作按钮双列分组
  - 输入项增加显式标签（非仅 placeholder）
  - 日志按钮并排，减少滚动高度
  - 统一 Material 视觉组件
- [x] `strings.xml` 新增对应文案。
- [x] 新增 `colors.xml` 与主题色统一。
- [x] 按钮交互反馈增强：
  - 测试连接时按钮禁用+文案切换
  - 保存设置时按钮禁用+文案切换

## 验证结果

- 语义检查：关键字段引用存在，ID 绑定完整。
- 编译验证：本机执行 `:app:compileDebugKotlin` 失败，原因是缺少 Android SDK 路径配置（非代码语法错误）。

## 阻塞项

- 本机需配置 `ANDROID_HOME` 或 `local.properties` 的 `sdk.dir` 后才能完成编译验收。
- 你当前要求使用 GitHub 打包，此阻塞不影响云端 Actions 编译。
