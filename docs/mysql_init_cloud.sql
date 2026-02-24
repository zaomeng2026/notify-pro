CREATE DATABASE IF NOT EXISTS notify_pro_saas
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_general_ci;

USE notify_pro_saas;

CREATE TABLE IF NOT EXISTS tenants (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_code VARCHAR(64) NOT NULL UNIQUE,
  tenant_name VARCHAR(120) NOT NULL,
  status TINYINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'admin',
  status TINYINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE KEY uk_tenant_username (tenant_id, username),
  KEY idx_users_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS devices (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  device_id VARCHAR(120) NOT NULL,
  device_name VARCHAR(120) NOT NULL DEFAULT '',
  platform VARCHAR(32) NOT NULL DEFAULT 'android',
  last_ip VARCHAR(64) NOT NULL DEFAULT '',
  last_seen_at BIGINT NOT NULL DEFAULT 0,
  status TINYINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE KEY uk_tenant_device (tenant_id, device_id),
  KEY idx_devices_tenant_seen (tenant_id, last_seen_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_records (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  channel VARCHAR(16) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  title VARCHAR(500) NOT NULL DEFAULT '',
  content VARCHAR(500) NOT NULL DEFAULT '',
  package_name VARCHAR(200) NOT NULL DEFAULT '',
  time_text VARCHAR(64) NOT NULL DEFAULT '',
  device_id VARCHAR(120) NOT NULL DEFAULT '',
  client_msg_id VARCHAR(200) NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  received_at BIGINT NOT NULL,
  KEY idx_records_tenant_created (tenant_id, created_at DESC),
  KEY idx_records_tenant_channel (tenant_id, channel, created_at DESC),
  KEY idx_records_tenant_clientmsg (tenant_id, client_msg_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
