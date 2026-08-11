'use strict';

const path = require('node:path');

const Util = require('./Util');
const ServerError = require('./ServerError');
const SqliteMigrator = require('./db/SqliteMigrator');

const sqlQuote = (value) => {
  if (value === null || typeof value === 'undefined') {
    return 'NULL';
  }

  return `'${String(value).replace(/'/g, '\'\'')}'`;
};

module.exports = class TelegramStore {

  constructor({
    basePath,
  }) {
    this.basePath = basePath;
    this.dbPath = path.join(basePath, 'wg-easy.db');
    this.initPromise = null;
    this.migrator = new SqliteMigrator({
      dbPath: this.dbPath,
      basePath: this.basePath,
    });
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = this.migrator.migrate().catch((err) => {
        throw new ServerError(`Failed to initialize Telegram store: ${err.message}`, 500);
      });
    }

    return this.initPromise;
  }

  async __query(sql) {
    await this.init();

    const stdout = await Util.execFile('sqlite3', [
      '-json',
      this.dbPath,
      sql,
    ], {
      log: false,
    }).catch((err) => {
      throw new ServerError(`Failed to query Telegram store: ${err.message}`, 500);
    });

    if (!stdout) {
      return [];
    }

    return JSON.parse(stdout);
  }

  async __exec(sql) {
    await this.init();

    await Util.execFile('sqlite3', [
      this.dbPath,
      sql,
    ], {
      log: false,
    }).catch((err) => {
      throw new ServerError(`Failed to update Telegram store: ${err.message}`, 500);
    });
  }

  async getBotOffset() {
    const rows = await this.__query(`
      SELECT value
      FROM telegram_bot_state
      WHERE key = 'update_offset'
      LIMIT 1;
    `);

    if (!Array.isArray(rows) || rows.length === 0) {
      return 0;
    }

    return Math.max(0, parseInt(rows[0].value, 10) || 0);
  }

  async setBotOffset(offset) {
    await this.__exec(`
      INSERT INTO telegram_bot_state (key, value, updated_at)
      VALUES ('update_offset', ${sqlQuote(String(offset))}, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  async getBotState(key) {
    const rows = await this.__query(`
      SELECT value
      FROM telegram_bot_state
      WHERE key = ${sqlQuote(String(key))}
      LIMIT 1;
    `);

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    return rows[0].value;
  }

  async setBotState(key, value) {
    await this.__exec(`
      INSERT INTO telegram_bot_state (key, value, updated_at)
      VALUES (${sqlQuote(String(key))}, ${sqlQuote(String(value))}, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  async deleteBotState(key) {
    await this.__exec(`
      DELETE FROM telegram_bot_state
      WHERE key = ${sqlQuote(String(key))};
    `);
  }

  async getTelegramUser(telegramUserId) {
    const rows = await this.__query(`
      SELECT
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        username,
        first_name AS firstName,
        last_name AS lastName,
        status,
        allow_multi_device AS allowMultiDevice,
        subscription_expires_at AS subscriptionExpiresAt,
        subscription_grace_until AS subscriptionGraceUntil,
        last_subscription_reminder_at AS lastSubscriptionReminderAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM telegram_users
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))}
      LIMIT 1;
    `);

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    return {
      ...rows[0],
      allowMultiDevice: Number(rows[0].allowMultiDevice) === 1,
    };
  }

  async listLinkedClientIds(telegramUserId) {
    const rows = await this.__query(`
      SELECT client_id AS clientId
      FROM telegram_client_links
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))}
      ORDER BY created_at ASC;
    `);

    return rows.map((row) => row.clientId);
  }

  async listLinkedClients(telegramUserId) {
    return this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        client_id AS clientId,
        created_at AS createdAt
      FROM telegram_client_links
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))}
      ORDER BY created_at ASC;
    `);
  }

  async listTelegramUsers() {
    return this.__query(`
      SELECT
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        username,
        first_name AS firstName,
        last_name AS lastName,
        status,
        allow_multi_device AS allowMultiDevice,
        subscription_expires_at AS subscriptionExpiresAt,
        subscription_grace_until AS subscriptionGraceUntil,
        last_subscription_reminder_at AS lastSubscriptionReminderAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM telegram_users
      ORDER BY updated_at DESC, created_at DESC;
    `).then((rows) => rows.map((row) => ({
      ...row,
      allowMultiDevice: Number(row.allowMultiDevice) === 1,
    })));
  }

  async upsertPendingUser({
    telegramUserId,
    chatId,
    username = '',
    firstName = '',
    lastName = '',
  }) {
    await this.__exec(`
      INSERT INTO telegram_users (
        telegram_user_id, chat_id, username, first_name, last_name, status, updated_at
      ) VALUES (
        ${sqlQuote(String(telegramUserId))},
        ${sqlQuote(String(chatId))},
        ${sqlQuote(username)},
        ${sqlQuote(firstName)},
        ${sqlQuote(lastName)},
        'pending',
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  async getPendingRequestForTelegramUser(telegramUserId) {
    const rows = await this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        username,
        first_name AS firstName,
        last_name AS lastName,
        status,
        requested_at AS requestedAt,
        resolved_at AS resolvedAt,
        client_id AS clientId
      FROM telegram_pending_requests
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))}
        AND status = 'pending'
      ORDER BY requested_at DESC
      LIMIT 1;
    `);

    return rows[0] || null;
  }

  async getPendingRequest(requestId) {
    const rows = await this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        username,
        first_name AS firstName,
        last_name AS lastName,
        status,
        requested_at AS requestedAt,
        resolved_at AS resolvedAt,
        client_id AS clientId
      FROM telegram_pending_requests
      WHERE id = ${sqlQuote(String(requestId))}
      LIMIT 1;
    `);

    return rows[0] || null;
  }

  async createPendingRequest(request) {
    await this.__exec(`
      INSERT INTO telegram_pending_requests (
        id, telegram_user_id, chat_id, username, first_name, last_name, status
      ) VALUES (
        ${sqlQuote(request.id)},
        ${sqlQuote(String(request.telegramUserId))},
        ${sqlQuote(String(request.chatId))},
        ${sqlQuote(request.username || '')},
        ${sqlQuote(request.firstName || '')},
        ${sqlQuote(request.lastName || '')},
        'pending'
      );
    `);

    return this.getPendingRequest(request.id);
  }

  async listPendingRequests() {
    return this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        username,
        first_name AS firstName,
        last_name AS lastName,
        status,
        requested_at AS requestedAt
      FROM telegram_pending_requests
      WHERE status = 'pending'
      ORDER BY requested_at ASC;
    `);
  }

  async createCallbackAction({
    id,
    action,
    payload = {},
    expiresAt = null,
    actorTelegramUserId = null,
  }) {
    await this.__exec(`
      INSERT INTO telegram_callback_actions (
        id, action, payload, expires_at, actor_telegram_user_id
      ) VALUES (
        ${sqlQuote(id)},
        ${sqlQuote(action)},
        ${sqlQuote(JSON.stringify(payload || {}))},
        ${sqlQuote(expiresAt)},
        ${sqlQuote(actorTelegramUserId ? String(actorTelegramUserId) : null)}
      );
    `);

    return id;
  }

  async getCallbackAction(id) {
    const rows = await this.__query(`
      SELECT
        id,
        action,
        payload,
        expires_at AS expiresAt,
        actor_telegram_user_id AS actorTelegramUserId,
        created_at AS createdAt
      FROM telegram_callback_actions
      WHERE id = ${sqlQuote(String(id))}
      LIMIT 1;
    `);

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      await this.deleteCallbackAction(id);
      return null;
    }

    return {
      ...row,
      payload: row.payload ? JSON.parse(row.payload) : {},
    };
  }

  async deleteCallbackAction(id) {
    await this.__exec(`
      DELETE FROM telegram_callback_actions
      WHERE id = ${sqlQuote(String(id))};
    `);
  }

  async purgeExpiredCallbackActions() {
    await this.__exec(`
      DELETE FROM telegram_callback_actions
      WHERE expires_at IS NOT NULL
        AND datetime(expires_at) <= datetime('now');
    `);
  }

  async approveRequest({
    requestId,
    clientId,
    allowMultiDevice = false,
    adminTelegramUserId = null,
  }) {
    const request = await this.getPendingRequest(requestId);
    if (!request) {
      throw new ServerError(`Telegram request not found: ${requestId}`, 404);
    }
    if (request.status !== 'pending') {
      throw new ServerError(`Telegram request is already resolved: ${requestId}`, 409);
    }

    await this.__exec(`
      UPDATE telegram_pending_requests
      SET
        status = 'approved',
        client_id = ${sqlQuote(clientId)},
        resolved_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlQuote(requestId)};

      INSERT INTO telegram_users (
        telegram_user_id, chat_id, username, first_name, last_name, status, allow_multi_device, updated_at
      ) VALUES (
        ${sqlQuote(String(request.telegramUserId))},
        ${sqlQuote(String(request.chatId))},
        ${sqlQuote(request.username || '')},
        ${sqlQuote(request.firstName || '')},
        ${sqlQuote(request.lastName || '')},
        'approved',
        ${allowMultiDevice ? 1 : 0},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        status = 'approved',
        allow_multi_device = excluded.allow_multi_device,
        updated_at = CURRENT_TIMESTAMP;
    `);

    await this.linkClient({
      telegramUserId: request.telegramUserId,
      clientId,
    });

    await this.logAction({
      telegramUserId: request.telegramUserId,
      adminTelegramUserId,
      action: 'approve_request',
      details: JSON.stringify({
        requestId,
        clientId,
        allowMultiDevice,
      }),
    });

    return this.getTelegramUser(request.telegramUserId);
  }

  async upsertApprovedUser({
    telegramUserId,
    chatId,
    username = '',
    firstName = '',
    lastName = '',
    allowMultiDevice = true,
    adminTelegramUserId = null,
  }) {
    await this.__exec(`
      INSERT INTO telegram_users (
        telegram_user_id, chat_id, username, first_name, last_name, status, allow_multi_device, updated_at
      ) VALUES (
        ${sqlQuote(String(telegramUserId))},
        ${sqlQuote(String(chatId))},
        ${sqlQuote(username)},
        ${sqlQuote(firstName)},
        ${sqlQuote(lastName)},
        'approved',
        ${allowMultiDevice ? 1 : 0},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        status = 'approved',
        allow_multi_device = excluded.allow_multi_device,
        updated_at = CURRENT_TIMESTAMP;
    `);

    await this.logAction({
      telegramUserId,
      adminTelegramUserId,
      action: 'upsert_approved_user',
      details: JSON.stringify({
        allowMultiDevice,
      }),
    });

    return this.getTelegramUser(telegramUserId);
  }

  async rejectRequest(requestId, adminTelegramUserId = null) {
    const request = await this.getPendingRequest(requestId);
    if (!request) {
      throw new ServerError(`Telegram request not found: ${requestId}`, 404);
    }
    if (request.status !== 'pending') {
      throw new ServerError(`Telegram request is already resolved: ${requestId}`, 409);
    }
    await this.__exec(`
      UPDATE telegram_pending_requests
      SET
        status = 'rejected',
        resolved_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlQuote(String(requestId))};

      UPDATE telegram_users
      SET
        status = 'rejected',
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = (
        SELECT telegram_user_id
        FROM telegram_pending_requests
        WHERE id = ${sqlQuote(String(requestId))}
        LIMIT 1
      );
    `);

    if (request) {
      await this.logAction({
        telegramUserId: request.telegramUserId,
        adminTelegramUserId,
        action: 'reject_request',
        details: JSON.stringify({
          requestId,
        }),
      });
    }
  }

  async linkClient({
    telegramUserId,
    clientId,
    adminTelegramUserId = null,
  }) {
    const linkId = `${telegramUserId}:${clientId}`;

    await this.__exec(`
      INSERT OR IGNORE INTO telegram_client_links (
        id, telegram_user_id, client_id
      ) VALUES (
        ${sqlQuote(linkId)},
        ${sqlQuote(String(telegramUserId))},
        ${sqlQuote(String(clientId))}
      );
    `);

    await this.logAction({
      telegramUserId,
      adminTelegramUserId,
      action: 'link_client',
      details: JSON.stringify({
        clientId,
      }),
    });
  }

  async unlinkClient({
    telegramUserId,
    clientId,
    adminTelegramUserId = null,
  }) {
    await this.__exec(`
      DELETE FROM telegram_client_links
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))}
        AND client_id = ${sqlQuote(String(clientId))};
    `);

    await this.logAction({
      telegramUserId,
      adminTelegramUserId,
      action: 'unlink_client',
      details: JSON.stringify({
        clientId,
      }),
    });
  }

  async setAllowMultiDevice(telegramUserId, enabled, adminTelegramUserId = null) {
    await this.__exec(`
      UPDATE telegram_users
      SET
        allow_multi_device = ${enabled ? 1 : 0},
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))};
    `);

    await this.logAction({
      telegramUserId,
      adminTelegramUserId,
      action: 'set_allow_multi_device',
      details: JSON.stringify({
        enabled,
      }),
    });
  }

  async setUserStatus(telegramUserId, status, adminTelegramUserId = null) {
    await this.__exec(`
      UPDATE telegram_users
      SET
        status = ${sqlQuote(String(status))},
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))};
    `);

    await this.logAction({
      telegramUserId,
      adminTelegramUserId,
      action: 'set_status',
      details: JSON.stringify({
        status,
      }),
    });
  }

  async listRecentAuditLog(limit = 20) {
    const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));

    return this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        admin_telegram_user_id AS adminTelegramUserId,
        action,
        details,
        created_at AS createdAt
      FROM telegram_audit_log
      ORDER BY created_at DESC
      LIMIT ${safeLimit};
    `);
  }

  async logAction({
    telegramUserId = null,
    adminTelegramUserId = null,
    action,
    details = null,
  }) {
    await this.__exec(`
      INSERT INTO telegram_audit_log (
        id, telegram_user_id, admin_telegram_user_id, action, details
      ) VALUES (
        ${sqlQuote(`${Date.now()}-${Math.random().toString(16).slice(2)}`)},
        ${sqlQuote(telegramUserId ? String(telegramUserId) : null)},
        ${sqlQuote(adminTelegramUserId ? String(adminTelegramUserId) : null)},
        ${sqlQuote(action)},
        ${sqlQuote(details)}
      );
    `);
  }

  async getPendingSubscriptionRequestForTelegramUser(telegramUserId) {
    const rows = await this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        status,
        phone_number AS phoneNumber,
        amount_rub AS amountRub,
        requested_at AS requestedAt,
        resolved_at AS resolvedAt,
        admin_telegram_user_id AS adminTelegramUserId,
        note
      FROM telegram_subscription_requests
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))}
        AND status = 'pending'
      ORDER BY requested_at DESC
      LIMIT 1;
    `);

    return rows[0] || null;
  }

  async getSubscriptionRequest(requestId) {
    const rows = await this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        status,
        phone_number AS phoneNumber,
        amount_rub AS amountRub,
        requested_at AS requestedAt,
        resolved_at AS resolvedAt,
        admin_telegram_user_id AS adminTelegramUserId,
        note
      FROM telegram_subscription_requests
      WHERE id = ${sqlQuote(String(requestId))}
      LIMIT 1;
    `);

    return rows[0] || null;
  }

  async createSubscriptionRequest({
    id,
    telegramUserId,
    chatId,
    phoneNumber,
    amountRub = 200,
  }) {
    const existing = await this.getPendingSubscriptionRequestForTelegramUser(telegramUserId);
    if (existing) {
      return existing;
    }

    await this.__exec(`
      INSERT INTO telegram_subscription_requests (
        id, telegram_user_id, chat_id, status, phone_number, amount_rub
      ) VALUES (
        ${sqlQuote(String(id))},
        ${sqlQuote(String(telegramUserId))},
        ${sqlQuote(String(chatId))},
        'pending',
        ${sqlQuote(phoneNumber || '')},
        ${Math.max(1, parseInt(amountRub, 10) || 200)}
      );
    `);

    await this.logAction({
      telegramUserId,
      action: 'create_subscription_request',
      details: JSON.stringify({
        requestId: id,
        phoneNumber,
        amountRub,
      }),
    });

    return this.getSubscriptionRequest(id);
  }

  async listPendingSubscriptionRequests() {
    return this.__query(`
      SELECT
        id,
        telegram_user_id AS telegramUserId,
        chat_id AS chatId,
        status,
        phone_number AS phoneNumber,
        amount_rub AS amountRub,
        requested_at AS requestedAt,
        resolved_at AS resolvedAt,
        admin_telegram_user_id AS adminTelegramUserId,
        note
      FROM telegram_subscription_requests
      WHERE status = 'pending'
      ORDER BY requested_at ASC;
    `);
  }

  async approveSubscriptionRequest({
    requestId,
    adminTelegramUserId = null,
    durationDays = 30,
    graceDays = 7,
  }) {
    const request = await this.getSubscriptionRequest(requestId);
    if (!request) {
      throw new ServerError(`Subscription request not found: ${requestId}`, 404);
    }
    if (request.status !== 'pending') {
      throw new ServerError(`Subscription request is already resolved: ${requestId}`, 409);
    }

    const user = await this.getTelegramUser(request.telegramUserId);
    if (!user) {
      throw new ServerError(`Telegram user not found: ${request.telegramUserId}`, 404);
    }

    const now = Date.now();
    const baseUntil = user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > now
      ? new Date(user.subscriptionExpiresAt).getTime()
      : now;
    const nextSubscriptionExpiresAt = new Date(baseUntil + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const nextSubscriptionGraceUntil = new Date(new Date(nextSubscriptionExpiresAt).getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString();

    await this.__exec(`
      UPDATE telegram_subscription_requests
      SET
        status = 'approved',
        resolved_at = CURRENT_TIMESTAMP,
        admin_telegram_user_id = ${sqlQuote(adminTelegramUserId ? String(adminTelegramUserId) : null)}
      WHERE id = ${sqlQuote(String(requestId))};

      UPDATE telegram_users
      SET
        subscription_expires_at = ${sqlQuote(nextSubscriptionExpiresAt)},
        subscription_grace_until = ${sqlQuote(nextSubscriptionGraceUntil)},
        last_subscription_reminder_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ${sqlQuote(String(request.telegramUserId))};
    `);

    await this.logAction({
      telegramUserId: request.telegramUserId,
      adminTelegramUserId,
      action: 'approve_subscription_request',
      details: JSON.stringify({
        requestId,
        durationDays,
        graceDays,
        subscriptionExpiresAt: nextSubscriptionExpiresAt,
        subscriptionGraceUntil: nextSubscriptionGraceUntil,
      }),
    });

    return this.getTelegramUser(request.telegramUserId);
  }

  async rejectSubscriptionRequest(requestId, adminTelegramUserId = null, note = null) {
    const request = await this.getSubscriptionRequest(requestId);
    if (!request) {
      throw new ServerError(`Subscription request not found: ${requestId}`, 404);
    }
    if (request.status !== 'pending') {
      throw new ServerError(`Subscription request is already resolved: ${requestId}`, 409);
    }
    await this.__exec(`
      UPDATE telegram_subscription_requests
      SET
        status = 'rejected',
        resolved_at = CURRENT_TIMESTAMP,
        admin_telegram_user_id = ${sqlQuote(adminTelegramUserId ? String(adminTelegramUserId) : null)},
        note = ${sqlQuote(note)}
      WHERE id = ${sqlQuote(String(requestId))};
    `);

    if (request) {
      await this.logAction({
        telegramUserId: request.telegramUserId,
        adminTelegramUserId,
        action: 'reject_subscription_request',
        details: JSON.stringify({
          requestId,
          note,
        }),
      });
    }
  }

  async revokeSubscription(telegramUserId, adminTelegramUserId = null) {
    const user = await this.getTelegramUser(telegramUserId);
    if (!user) {
      throw new ServerError(`Telegram user not found: ${telegramUserId}`, 404);
    }

    const revokedAt = new Date().toISOString();

    await this.__exec(`
      UPDATE telegram_users
      SET
        subscription_expires_at = ${sqlQuote(revokedAt)},
        subscription_grace_until = ${sqlQuote(revokedAt)},
        last_subscription_reminder_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))};
    `);

    await this.logAction({
      telegramUserId,
      adminTelegramUserId,
      action: 'revoke_subscription',
      details: JSON.stringify({
        revokedAt,
      }),
    });

    return this.getTelegramUser(telegramUserId);
  }

  async markSubscriptionReminderSent(telegramUserId, at = new Date().toISOString()) {
    await this.__exec(`
      UPDATE telegram_users
      SET
        last_subscription_reminder_at = ${sqlQuote(at)},
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ${sqlQuote(String(telegramUserId))};
    `);
  }

};
