# ACCEPTANCE_单租户商用加固

## 完成项

- [x] 6A 文档已补齐：
  - `ALIGNMENT/CONSENSUS/DESIGN/TASK_单租户商用加固.md`
- [x] 服务端新增：
  - `GET /api/diagnostics`（管理员诊断）
  - `GET /api/records/export.csv`（CSV 导出）
  - `POST /api/backups/create`（手动备份）
  - `GET /api/backups`（备份列表）
- [x] 后台设置新增：
  - 备份保留份数（`backupKeep`）
  - 自动备份时间（`autoDailyBackupHour`）
  - 保存后即时生效，无需重启
- [x] 文件写入改为原子替换（`writeJson`）。
- [x] 自动备份调度能力：
  - `AUTO_DAILY_BACKUP`
  - `AUTO_DAILY_BACKUP_HOUR`
  - `BACKUP_KEEP`
- [x] 文档同步：
  - `README.md`
  - `docs/BAOTA_部署指南_双版本.md`

## 验证

- `node --check server.js` 通过
- `node --check bootstrap.js` 通过
- 冒烟联调中，接口返回已通过（health/diagnostics/backups/csv），
  但本机 Node 24 在强制结束测试进程时出现 Windows 断言日志，不影响功能实现本身。

## 残余风险

- CSV 导出目前按内存构造，超大数据量时建议分批导出（后续优化）。
- 备份目录为本机磁盘，建议配合定期异机备份。
