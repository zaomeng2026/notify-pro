# CONSENSUS_移动端审查与UI重构

## 需求共识

- 先修一致性 bug，再做 UI 重构，避免只换皮不解决可用性问题。
- 保持现有接口兼容，尽量小范围改动提高稳定性。

## 技术方案

1. API 鉴权补齐
- `NotifyApi.saveSettings` 支持传入管理员密码并写入 `X-Admin-Password`。
- `MainActivity` 新增管理员密码输入/保存逻辑并调用保存接口时透传。

2. 配置模型对齐
- `NotifyApi.ShopSettings` 增加：
  - `backupKeep`
  - `autoDailyBackupHour`
- `loadSettings/saveSettings` 与服务端字段对齐。

3. UI 重构（基于 ui-ux-pro-max 原则）
- 页面采用分区卡片：
  - 运行状态
  - 服务器与绑定
  - 连接测试
  - 店铺与大屏配置
  - 日志
- 保证触达尺寸、文本层级、可滚动可读性。

## 技术约束

- 继续使用 XML + ViewBinding，不切换到 Compose。
- 保留现有控件 id（或同步更新代码），避免破坏主逻辑。
