CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  allow_multi_device INTEGER NOT NULL DEFAULT 0,
  subscription_expires_at TEXT,
  subscription_grace_until TEXT,
  last_subscription_reminder_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_pending_requests (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  client_id TEXT
);

CREATE TABLE IF NOT EXISTS telegram_client_links (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(telegram_user_id, client_id)
);

CREATE TABLE IF NOT EXISTS telegram_audit_log (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT,
  admin_telegram_user_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_callback_actions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_subscription_requests (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  phone_number TEXT,
  amount_rub INTEGER NOT NULL DEFAULT 200,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  admin_telegram_user_id TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS telegram_bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_status ON telegram_users(status);
CREATE INDEX IF NOT EXISTS idx_telegram_pending_requests_status_requested_at ON telegram_pending_requests(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_telegram_client_links_user ON telegram_client_links(telegram_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_callback_actions_expires_at ON telegram_callback_actions(expires_at);
CREATE INDEX IF NOT EXISTS idx_telegram_subscription_requests_status_requested_at ON telegram_subscription_requests(status, requested_at);
