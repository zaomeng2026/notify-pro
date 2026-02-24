# DESIGN_单租户商用加固

## 架构增量

```mermaid
flowchart LR
  API[Express API] --> DIAG[/api/diagnostics]
  API --> CSV[/api/records/export.csv]
  API --> BAK[/api/backups/create]
  BAK --> FS[(data/backups)]
  CORE[writeJson] --> ATOMIC[atomic write]
```

## 模块说明

- `atomic write`：文件落盘防中断损坏。
- `backup service`：创建备份目录、复制关键数据文件、轮转清理。
- `diagnostics service`：聚合运行状态并生成建议。
- `csv export`：标准字段导出，方便商户核账。

## 接口契约

- `GET /api/diagnostics`（管理员）
  - 返回 `checks`、`warnings`、`errors`、`suggestions`
- `POST /api/backups/create`（管理员）
  - 返回 `backupId`、`dir`、`files`
- `GET /api/records/export.csv`（管理员）
  - query: `limit`
  - 返回 CSV 附件

## 异常策略

- 备份失败不影响主流程，仅返回错误信息。
- 导出失败返回 500，不影响收款主链路。
