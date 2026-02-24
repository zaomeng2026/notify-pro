# TODO_移动端审查与UI重构

## 必做环境项

1. 配置 Android SDK 路径（否则无法本地编译）
- `local.properties` 增加：
  - `sdk.dir=C:\\Users\\<你用户名>\\AppData\\Local\\Android\\Sdk`

## 建议后续优化

1. 手机端增加“后台密码验证”按钮，避免保存时才发现密码错误。
2. 手机端增加“备份列表/手动备份”可视化按钮（对接 `/api/backups`、`/api/backups/create`）。
3. 把“二维码图片地址”升级为“本地图片上传”交互，减少手工输入 URL。
