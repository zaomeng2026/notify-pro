CREATE DATABASE IF NOT EXISTS notify_pro
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_general_ci;

USE notify_pro;

CREATE TABLE IF NOT EXISTS payment_records (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  channel VARCHAR(16) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  title VARCHAR(500) NOT NULL DEFAULT '',
  content VARCHAR(500) NOT NULL DEFAULT '',
  package_name VARCHAR(200) NOT NULL DEFAULT '',
  time_text VARCHAR(64) NOT NULL DEFAULT '',
  device VARCHAR(120) NOT NULL DEFAULT '',
  client_msg_id VARCHAR(200) NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  received_at BIGINT NOT NULL,
  INDEX idx_payment_created_at (created_at DESC),
  INDEX idx_payment_client_msg_id (client_msg_id),
  INDEX idx_payment_channel_created (channel, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
