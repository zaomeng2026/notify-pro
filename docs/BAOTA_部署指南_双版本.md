# 宝塔部署指南（双版本）

## 0. 前置条件

- 宝塔已安装：Nginx、MySQL、PM2 管理器（或 Node 项目管理器）。
- 服务器已安装 Node.js 18+。
- 项目目录：`/www/wwwroot/notify-pro`

---

## 1. 局域网版（LAN）

### 1.1 环境变量

- `DEPLOY_MODE=lan`
- `PORT=3180`
- `PUBLIC_BASE_URL=`（可空，自动识别局域网 IP）
- `MYSQL_URL=`（可空，空则 JSON 存储）

### 1.2 PM2 启动

```bash
cd /www/wwwroot/notify-pro
npm install --omit=dev
pm2 start bootstrap.js --name notify-pro-lan -- lan
pm2 save
pm2 startup
```

### 1.3 访问

- 展示页：`http://局域网IP:3180/`
- 后台：`http://局域网IP:3180/admin`

---

## 2. 云服务器版（CLOUD）

### 2.1 必填环境变量

- `DEPLOY_MODE=cloud`
- `PORT=3180`
- `PUBLIC_BASE_URL=https://你的域名`
- `MYSQL_URL=mysql://user:pass@127.0.0.1:3306/notify_pro?charset=utf8mb4`
- `ADMIN_PASSWORD=强密码`
- `STRICT_CLOUD_MYSQL=true`

### 2.2 MySQL 初始化

单租户云部署（当前代码可直接跑）：

```sql
source /www/wwwroot/notify-pro/docs/mysql_init.sql;
```

未来 SaaS 多租户模型草案：

```sql
source /www/wwwroot/notify-pro/docs/mysql_init_cloud.sql;
```

### 2.3 PM2 启动

```bash
cd /www/wwwroot/notify-pro
npm install --omit=dev
pm2 start bootstrap.js --name notify-pro-cloud -- cloud
pm2 save
pm2 startup
```

### 2.4 Nginx 反向代理

- 参考模板：`deploy/baota/nginx_notify_pro_cloud.conf`
- 把域名替换成你自己的，配置 SSL 证书。

---

## 3. 运维常用命令

```bash
pm2 ls
pm2 logs notify-pro-cloud --lines 200
pm2 restart notify-pro-cloud
pm2 stop notify-pro-cloud
```

可选环境变量（建议）：

- `BACKUP_KEEP=30`（保留备份份数）
- `AUTO_DAILY_BACKUP=true`
- `AUTO_DAILY_BACKUP_HOUR=4`

---

## 4. 升级流程（推荐）

1. 备份 `data/` 与数据库。
2. 拉取新代码。
3. `npm install --omit=dev`
4. `pm2 restart notify-pro-cloud`
5. 检查 `GET /api/health` 返回 `ok=true`。

---

## 5. 常见问题

- 云端启动报错 `cloud mode requires PUBLIC_BASE_URL`：
  - 未配置公网地址，先补全环境变量。
- 云端启动报错 `cloud mode requires MYSQL_URL`：
  - 云端模式强制 MySQL，补齐连接串。
- 手机无法配对：
  - 确认域名可公网访问、Nginx 已反代到 `127.0.0.1:3180`、防火墙放行 80/443。
- 数据导出：
  - 使用管理员权限访问 `GET /api/records/export.csv` 下载 CSV。
