ALTER TABLE telegram_callback_actions ADD COLUMN actor_telegram_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_telegram_callback_actions_actor ON telegram_callback_actions(actor_telegram_user_id, expires_at);
