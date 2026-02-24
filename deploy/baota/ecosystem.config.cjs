module.exports = {
  apps: [
    {
      name: 'notify-pro-lan',
      script: './bootstrap.js',
      args: 'lan',
      cwd: '/www/wwwroot/notify-pro',
      env: {
        NODE_ENV: 'production',
        DEPLOY_MODE: 'lan',
        PORT: '3180'
      }
    },
    {
      name: 'notify-pro-cloud',
      script: './bootstrap.js',
      args: 'cloud',
      cwd: '/www/wwwroot/notify-pro',
      env: {
        NODE_ENV: 'production',
        DEPLOY_MODE: 'cloud',
        PORT: '3180',
        PUBLIC_BASE_URL: 'https://pay.example.com',
        MYSQL_URL: 'mysql://notify_user:notify_pass@127.0.0.1:3306/notify_pro?charset=utf8mb4',
        MYSQL_POOL_SIZE: '15',
        ADMIN_PASSWORD: 'change_me',
        STRICT_CLOUD_MYSQL: 'true',
        CLOUD_ALLOW_LOCAL_BASE: 'false'
      }
    }
  ]
};
