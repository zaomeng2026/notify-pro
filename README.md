# notify-pro

收款数据同步大屏（商业版）。

## 运行模式

- `LAN`（默认）：单机局域网版，适合门店本地部署。
- `CLOUD`：云服务器版，要求配置公网 `PUBLIC_BASE_URL` 和 `MYSQL_URL`。

## 快速启动（局域网）

```bash
npm install
npm run start:lan
```

- Display: `http://localhost:3180/`
- Admin: `http://localhost:3180/admin`

Windows 可直接双击：`一键启动.bat`

## 云端模式启动

先设置环境变量（示例见 `.env.cloud.example`）：

```bash
export DEPLOY_MODE=cloud
export PUBLIC_BASE_URL=https://pay.example.com
export MYSQL_URL=mysql://user:pass@127.0.0.1:3306/notify_pro?charset=utf8mb4
export ADMIN_PASSWORD=change_me
```

再启动：

```bash
npm install
npm run start:cloud
```

## MySQL（收款记录）

初始化 SQL：`docs/mysql_init.sql`  
云版多租户草案：`docs/mysql_init_cloud.sql`

## 商用加固能力（单租户）

- JSON 原子写入（降低文件损坏概率）
- 后台可配置：`备份保留份数`、`自动备份时间`
- 备份接口：
  - `POST /api/backups/create`（管理员）
  - `GET /api/backups`（管理员）
- 诊断接口：
  - `GET /api/diagnostics`（管理员）
- CSV 导出：
  - `GET /api/records/export.csv?limit=5000`（管理员）

## 宝塔部署

详见：`docs/BAOTA_部署指南_双版本.md`

## Android 工程

- `app/`：Android 客户端源码
- `.github/workflows/android-debug.yml`：云端编译 Debug APK
- `.github/workflows/android-release.yml`：云端编译 Release APK（需签名）
