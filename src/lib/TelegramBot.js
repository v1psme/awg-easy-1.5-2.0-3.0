'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');

const debug = require('debug')('TelegramBot');
const QRCode = require('qrcode');

const TelegramStore = require('./TelegramStore');
const ConfigStore = require('./ConfigStore');
const ServerError = require('./ServerError');
const TelegramUserAccessService = require('./telegram/TelegramUserAccessService');

const {
  WG_PATH,
  TELEGRAM_BOT_ENABLED,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ADMIN_IDS,
  TELEGRAM_BOT_POLL_TIMEOUT_SECONDS,
} = require('../config');

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const TELEGRAM_SUBSCRIPTION_PRICE_RUB = 200;
const TELEGRAM_SUBSCRIPTION_DURATION_DAYS = 30;
const TELEGRAM_SUBSCRIPTION_GRACE_DAYS = 7;

module.exports = class TelegramBot {

  constructor(wireGuard) {
    this.wireGuard = wireGuard;
    this.enabled = false;
    this.token = '';
    this.adminIds = [];
    this.pollTimeoutSeconds = TELEGRAM_BOT_POLL_TIMEOUT_SECONDS;
    this.subscriptionPhoneNumber = '';
    this.subscriptionRecipientName = '';
    this.subscriptionBankName = '';
    this.subscriptionPaymentNote = '';
    this.store = new TelegramStore({
      basePath: WG_PATH,
    });
    this.configStore = new ConfigStore({
      basePath: WG_PATH,
    });
    this.running = false;
    this.pollLoopPromise = null;
    this.userAccess = new TelegramUserAccessService({
      wireGuard: this.wireGuard,
      store: this.store,
      subscriptionDurationDays: TELEGRAM_SUBSCRIPTION_DURATION_DAYS,
      subscriptionGraceDays: TELEGRAM_SUBSCRIPTION_GRACE_DAYS,
    });
  }

  async __enforceCooldown(key, cooldownSeconds) {
    const now = Date.now();
    const stateKey = `rate_limit:${key}`;
    const lastValue = await this.store.getBotState(stateKey);
    const lastAt = lastValue ? Number(lastValue) : 0;

    if (lastAt && (now - lastAt) < (cooldownSeconds * 1000)) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(((lastAt + (cooldownSeconds * 1000)) - now) / 1000)),
      };
    }

    await this.store.setBotState(stateKey, String(now));
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }

  async start() {
    const settings = await this.__loadSettingsWithRetry();
    this.enabled = settings.enabled;
    this.token = settings.token;
    this.adminIds = settings.adminIds;
    this.pollTimeoutSeconds = settings.pollTimeoutSeconds;
    this.subscriptionPhoneNumber = settings.subscriptionPhoneNumber;
    this.subscriptionRecipientName = settings.subscriptionRecipientName;
    this.subscriptionBankName = settings.subscriptionBankName;
    this.subscriptionPaymentNote = settings.subscriptionPaymentNote;

    // eslint-disable-next-line no-console
    console.log(`[TelegramBot] start enabled=${this.enabled} admins=${this.adminIds.length} token=${this.token ? 'set' : 'empty'} timeout=${this.pollTimeoutSeconds}`);

    if (!this.enabled) {
      debug('Telegram bot is disabled.');
      return;
    }

    if (!this.token) {
      // eslint-disable-next-line no-console
      console.warn('[TelegramBot] TELEGRAM_BOT_ENABLED=true but TELEGRAM_BOT_TOKEN is empty. Bot will not start.');
      return;
    }

    if (this.adminIds.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[TelegramBot] TELEGRAM_BOT_ENABLED=true but TELEGRAM_ADMIN_IDS is empty. Bot will not start.');
      return;
    }

    await this.store.init();
    this.running = true;
    this.pollLoopPromise = this.__pollLoop();
    debug('Telegram bot polling started.');
    // eslint-disable-next-line no-console
    console.log('[TelegramBot] polling started');
  }

  async reload() {
    // eslint-disable-next-line no-console
    console.log('[TelegramBot] reload requested');
    await this.stop();
    await this.start();
  }

  async stop() {
    this.running = false;
    if (this.pollLoopPromise) {
      await this.pollLoopPromise.catch(() => {});
      this.pollLoopPromise = null;
    }
  }

  async __pollLoop() {
    let offset = await this.store.getBotOffset().catch(() => 0);

    while (this.running) {
      try {
        await this.userAccess.runSubscriptionMaintenance({
          formatDate: (value) => this.__formatTelegramDate(value),
          onGraceReminder: async (user) => {
            await this.__sendApprovedUserHome(user, `Подписка закончилась. Льготный период действует до ${this.__formatTelegramDate(user.subscriptionGraceUntil)}. Продли доступ, чтобы сервис не отключился.`);
          },
        }).catch((err) => {
          debug(`Subscription maintenance failed: ${err.message}`);
        });
        await this.store.purgeExpiredCallbackActions().catch(() => {});
        const response = await this.__apiCall('getUpdates', {
          offset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
        });

        if (!Array.isArray(response.result)) {
          continue;
        }

        for (const update of response.result) {
          if (!this.running) {
            break;
          }

          offset = Math.max(offset, Number(update.update_id) + 1);
          await this.store.setBotOffset(offset).catch(() => {});
          await this.__handleUpdate(update);
        }
      } catch (err) {
        debug(`Telegram polling failed: ${err.message}`);
        // eslint-disable-next-line no-console
        console.warn(`[TelegramBot] polling failed: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  async __loadSettings() {
    const stored = await this.configStore.getTelegramSettings();
    const enabled = typeof stored?.enabled === 'boolean'
      ? stored.enabled
      : TELEGRAM_BOT_ENABLED === 'true';
    const token = typeof stored?.token === 'string' && stored.token.trim()
      ? stored.token.trim()
      : (typeof TELEGRAM_BOT_TOKEN === 'string' ? TELEGRAM_BOT_TOKEN.trim() : '');
    const adminIds = [...new Set(
      String(
        typeof stored?.adminIds === 'string' && stored.adminIds.trim()
          ? stored.adminIds
          : TELEGRAM_ADMIN_IDS || ''
      )
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    )];
    const pollTimeoutSeconds = Math.max(
      1,
      parseInt(stored?.pollTimeoutSeconds, 10) || TELEGRAM_BOT_POLL_TIMEOUT_SECONDS
    );
    const subscriptionPhoneNumber = typeof stored?.subscriptionPhoneNumber === 'string'
      ? stored.subscriptionPhoneNumber.trim()
      : '';
    const subscriptionRecipientName = typeof stored?.subscriptionRecipientName === 'string'
      ? stored.subscriptionRecipientName.trim()
      : '';
    const subscriptionBankName = typeof stored?.subscriptionBankName === 'string'
      ? stored.subscriptionBankName.trim()
      : '';
    const subscriptionPaymentNote = typeof stored?.subscriptionPaymentNote === 'string'
      ? stored.subscriptionPaymentNote.trim()
      : '';
    return {
      enabled: enabled === true,
      token,
      adminIds,
      pollTimeoutSeconds,
      subscriptionPhoneNumber,
      subscriptionRecipientName,
      subscriptionBankName,
      subscriptionPaymentNote,
    };
  }

  async __loadSettingsWithRetry() {
    let lastError = null;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const settings = await this.__loadSettings();
        const looksConfigured = settings.enabled && settings.token && settings.adminIds.length > 0;

        if (looksConfigured || attempt === 5) {
          return settings;
        }

        const stored = await this.configStore.getTelegramSettings().catch(() => null);
        const hasStoredTelegramSettings = !!stored && typeof stored === 'object'
          && (stored.enabled === true || !!stored.token || !!stored.adminIds);

        if (!hasStoredTelegramSettings) {
          return settings;
        }

        // eslint-disable-next-line no-console
        console.warn(`[TelegramBot] Telegram settings look incomplete on startup, retrying (${attempt}/5)...`);
      } catch (err) {
        lastError = err;
        // eslint-disable-next-line no-console
        console.warn(`[TelegramBot] Failed to load Telegram settings on startup (${attempt}/5): ${err.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (lastError) {
      throw lastError;
    }

    return this.__loadSettings();
  }

  async __handleUpdate(update) {
    if (update.callback_query) {
      await this.__handleCallbackQuery(update.callback_query);
      return;
    }

    if (update.message) {
      await this.__handleMessage(update.message);
    }
  }

  async __handleMessage(message) {
    if (!message.from || !message.chat || message.chat.type !== 'private') {
      return;
    }

    const telegramUserId = String(message.from.id);
    const chatId = String(message.chat.id);
    const text = typeof message.text === 'string' ? message.text.trim() : '';

    if (!text) {
      return;
    }

    if (this.__isAdmin(telegramUserId)) {
      await this.__handleAdminMessage({
        telegramUserId,
        chatId,
        text,
        message,
      });
      return;
    }

    const telegramUser = await this.store.getTelegramUser(telegramUserId);
    if (telegramUser && (telegramUser.status === 'blocked' || telegramUser.status === 'rejected')) {
      return;
    }

    if (telegramUser && telegramUser.status === 'approved') {
      await this.__handleApprovedUserMessage({
        telegramUser,
        text,
      });
      return;
    }

    const existingRequest = await this.store.getPendingRequestForTelegramUser(telegramUserId);
    if (existingRequest) {
      return;
    }

    await this.store.upsertPendingUser({
      telegramUserId,
      chatId,
      username: message.from.username || '',
      firstName: message.from.first_name || '',
      lastName: message.from.last_name || '',
    });

    const request = await this.store.createPendingRequest({
      id: crypto.randomUUID(),
      telegramUserId,
      chatId,
      username: message.from.username || '',
      firstName: message.from.first_name || '',
      lastName: message.from.last_name || '',
    });

    await this.__sendMessage(chatId, 'Заявка отправлена администратору. После подтверждения бот откроет доступ.');
    await this.__notifyAdminsAboutRequest(request);
  }

  async __handleApprovedUserMessage({
    telegramUser,
    text,
  }) {
    const supportComposeState = await this.store.getBotState(`support_compose:${telegramUser.telegramUserId}`);
    if (supportComposeState === '1' && text === '/cancel') {
      await this.store.deleteBotState(`support_compose:${telegramUser.telegramUserId}`);
      await this.__sendApprovedUserHome(telegramUser, 'Отправка сообщения в поддержку отменена.');
      return;
    }

    if (supportComposeState === '1' && text.startsWith('/')) {
      await this.store.deleteBotState(`support_compose:${telegramUser.telegramUserId}`);
    }

    if (supportComposeState === '1' && !text.startsWith('/')) {
      await this.store.deleteBotState(`support_compose:${telegramUser.telegramUserId}`);
      const cooldown = await this.__enforceCooldown(`support_message:${telegramUser.telegramUserId}`, 60);
      if (!cooldown.allowed) {
        await this.__sendApprovedUserHome(telegramUser, `Слишком часто. Попробуй снова через ${cooldown.retryAfterSeconds} сек.`);
        return;
      }
      await this.__forwardSupportMessageFromUser(telegramUser, text);
      await this.__sendApprovedUserHome(telegramUser, 'Сообщение в поддержку отправлено.');
      return;
    }

    if (text === '/start' || text === '/help') {
      await this.__sendApprovedUserHome(telegramUser);
      return;
    }

    if (text === '/me') {
      const links = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
      const subscriptionState = this.userAccess.getSubscriptionState(telegramUser, (value) => this.__formatTelegramDate(value));
      await this.__sendMessage(telegramUser.chatId, [
        `Telegram ID: ${telegramUser.telegramUserId}`,
        `Username: ${telegramUser.username || '-'}`,
        `Status: ${telegramUser.status}`,
        `Subscription: ${subscriptionState.label}`,
        `Multi-device: ${telegramUser.allowMultiDevice ? 'on' : 'off'}`,
        `Linked profiles: ${links.length}`,
      ].join('\n'));
      return;
    }

    if (text === '/route') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__sendSubscriptionMenu(telegramUser, {
          prefixMessage: 'Сначала нужно оформить или продлить подписку.',
        });
        return;
      }
      await this.__sendRouteClientPicker(telegramUser);
      return;
    }

    if (text === '/categories') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__sendSubscriptionMenu(telegramUser, {
          prefixMessage: 'Сначала нужно оформить или продлить подписку.',
        });
        return;
      }
      await this.__sendCategoryClientPicker(telegramUser);
      return;
    }

    if (text === '/myconfigs') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__sendSubscriptionMenu(telegramUser, {
          prefixMessage: 'Без активной подписки доступ к конфигам закрыт.',
        });
        return;
      }
      await this.__sendAccessFormatsMenu(telegramUser);
      return;
    }

    if (text === '/subscription') {
      await this.__sendSubscriptionMenu(telegramUser);
      return;
    }

    if (text.startsWith('/newdevice')) {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__sendSubscriptionMenu(telegramUser, {
          prefixMessage: 'Сначала нужно оформить или продлить подписку.',
        });
        return;
      }
      if (!telegramUser.allowMultiDevice) {
        await this.__sendMessage(telegramUser.chatId, 'Для твоего аккаунта дополнительные устройства пока не разрешены администратором.');
        return;
      }

      const suffix = text.replace('/newdevice', '').trim();
      const clients = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
      const deviceName = suffix || `${telegramUser.username || telegramUser.firstName || 'device'}-${clients.length + 1}`;
      const client = await this.wireGuard.createClient({
        name: deviceName,
        expiredDate: null,
      });
      await this.store.linkClient({
        telegramUserId: telegramUser.telegramUserId,
        clientId: client.id,
      });
      await this.__sendApprovedUserHome(telegramUser, `Новый профиль создан: ${client.name}. Доступ выдан.`);
      return;
    }

    await this.__sendMessage(telegramUser.chatId, 'Неизвестная команда. Используй /help.');
  }

  async __handleAdminMessage({
    telegramUserId,
    chatId,
    text,
    message,
  }) {
    const supportReplyUserId = await this.store.getBotState(`support_reply:${telegramUserId}`);
    if (supportReplyUserId && text === '/cancel') {
      await this.store.deleteBotState(`support_reply:${telegramUserId}`);
      await this.__sendMessage(chatId, 'Ответ в поддержку отменён.');
      return;
    }

    if (supportReplyUserId && text.startsWith('/')) {
      await this.store.deleteBotState(`support_reply:${telegramUserId}`);
    }

    if (supportReplyUserId && !text.startsWith('/')) {
      const targetUser = await this.store.getTelegramUser(String(supportReplyUserId));
      if (!targetUser) {
        await this.store.deleteBotState(`support_reply:${telegramUserId}`);
        await this.__sendMessage(chatId, `Пользователь поддержки не найден: ${supportReplyUserId}`);
        return;
      }

      await this.__sendMessage(targetUser.chatId, [
        'Ответ поддержки',
        '',
        text,
      ].join('\n'));
      await this.store.deleteBotState(`support_reply:${telegramUserId}`);
      await this.store.logAction({
        telegramUserId: targetUser.telegramUserId,
        adminTelegramUserId: telegramUserId,
        action: 'support_reply',
        details: JSON.stringify({
          message: text,
        }),
      });
      await this.__sendMessage(chatId, `Ответ отправлен пользователю ${targetUser.telegramUserId}.`);
      return;
    }

    if (text === '/start' || text === '/help') {
      await this.__sendAdminHome(chatId, null, {
        adminProfile: this.__getAdminProfilePayload(message),
      });
      return;
    }
    await this.__sendAdminHome(chatId, 'Используй inline-кнопки. Текстовые админ-команды отключены.');
  }

  async __handleCallbackQuery(callbackQuery) {
    const data = typeof callbackQuery.data === 'string' ? callbackQuery.data : '';
    const chatId = callbackQuery.message && callbackQuery.message.chat ? String(callbackQuery.message.chat.id) : null;
    const fromId = callbackQuery.from ? String(callbackQuery.from.id) : null;
    const sourceMessageId = callbackQuery.message?.message_id;

    if (!chatId || !fromId) {
      return;
    }

    if (!this.__isAdmin(fromId)) {
      await this.__handleUserCallbackQuery(callbackQuery, {
        data,
        fromId,
      });
      return;
    }

    if (data === 'tg:admin:home') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю меню.');
      await this.__sendAdminHome(chatId, null, {
        targetMessageId: sourceMessageId,
        adminProfile: this.__getAdminProfilePayload(callbackQuery),
      });
      return;
    }

    if (data === 'tg:admin:pending') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю заявки.');
      await this.__sendAdminPendingList(chatId, { targetMessageId: sourceMessageId });
      return;
    }

    if (data === 'tg:admin:users') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю пользователей.');
      await this.__sendAdminUsersList(chatId, 0, { targetMessageId: sourceMessageId });
      return;
    }

    if (data === 'tg:admin:subscriptions') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю оплаты.');
      await this.__sendAdminSubscriptionRequests(chatId, { targetMessageId: sourceMessageId });
      return;
    }

    if (data === 'tg:admin:configs') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю конфиги.');
      await this.__sendAdminConfigsList(chatId, 0, { targetMessageId: sourceMessageId });
      return;
    }

    if (data === 'tg:admin:self') {
      const adminUser = await this.__ensureAdminOwnProfile({
        telegramUserId: fromId,
        chatId,
        profile: this.__getAdminProfilePayload(callbackQuery),
      });
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю профиль.');
      await this.__sendAdminOwnProfile(chatId, adminUser, {
        targetMessageId: sourceMessageId,
      });
      return;
    }

    if (data === 'tg:admin:audit') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю аудит.');
      await this.__sendAdminAudit(chatId, { targetMessageId: sourceMessageId });
      return;
    }

    if (data.startsWith('tg:approve_create:')) {
      const requestId = data.replace('tg:approve_create:', '');
      const request = await this.store.getPendingRequest(requestId);
      if (!request || request.status !== 'pending') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Заявка уже обработана.');
        return;
      }

      const approved = await this.userAccess.approveRequestWithNewClient({
        requestId,
        adminTelegramUserId: fromId,
      });
      if (!approved) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Заявка уже обработана.');
        return;
      }
      const { client, user: approvedUser } = approved;

      await this.__answerCallbackQuery(callbackQuery.id, 'Профиль создан.');
      await this.__renderMessage(chatId, `Создан новый профиль ${client.name} для заявки ${requestId}.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, sourceMessageId);
      await this.__sendApprovedUserHome(approvedUser, `Доступ выдан. Для тебя создан новый профиль ${client.name}.`);
      return;
    }

    if (data.startsWith('tg:callback:')) {
      const callbackId = data.replace('tg:callback:', '');
      const callbackAction = await this.store.getCallbackAction(callbackId);
      if (!callbackAction) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Действие устарело. Открой список заново.');
        return;
      }
      if (callbackAction.actorTelegramUserId && String(callbackAction.actorTelegramUserId) !== String(fromId)) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Эта кнопка создана для другой сессии.');
        return;
      }

      if (callbackAction.action === 'show_bind_clients') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю список профилей.');
        await this.__sendExistingProfilesPicker({
          chatId,
          requestId: callbackAction.payload.requestId,
          page: Number(callbackAction.payload.page || 0),
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'approve_link_existing') {
        const { requestId, clientId } = callbackAction.payload;
        const request = await this.store.getPendingRequest(requestId);
        if (!request || request.status !== 'pending') {
          await this.__answerCallbackQuery(callbackQuery.id, 'Заявка уже обработана.');
          return;
        }

        const approved = await this.userAccess.approveRequestWithExistingClient({
          requestId,
          clientId,
          adminTelegramUserId: fromId,
        });
        if (!approved) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Заявка уже обработана.');
          return;
        }
        if (!approved.client) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Профиль больше не существует.');
          return;
        }
        const { client, user: approvedUser } = approved;

        await this.store.deleteCallbackAction(callbackId).catch(() => {});
        await this.__answerCallbackQuery(callbackQuery.id, 'Профиль привязан.');
        await this.__renderMessage(chatId, `Заявка ${requestId} привязана к клиенту ${client.name}.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'В меню', callback_data: 'tg:admin:home' }],
            ],
          },
        }, sourceMessageId);
        await this.__sendApprovedUserHome(approvedUser, `Доступ выдан. Твой аккаунт привязан к существующему профилю ${client.name}.`);
        return;
      }

      if (callbackAction.action === 'admin_users_page') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю страницу.');
        await this.__sendAdminUsersList(chatId, Number(callbackAction.payload.page || 0), { targetMessageId: sourceMessageId });
        return;
      }

      if (callbackAction.action === 'admin_configs_page') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю страницу.');
        await this.__sendAdminConfigsList(chatId, Number(callbackAction.payload.page || 0), { targetMessageId: sourceMessageId });
        return;
      }

      if (callbackAction.action === 'admin_view_request') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю заявку.');
        const request = await this.store.getPendingRequest(String(callbackAction.payload.requestId));
        if (!request || request.status !== 'pending') {
          await this.__renderMessage(chatId, 'Заявка уже обработана.', {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'К заявкам', callback_data: 'tg:admin:pending' }],
                [{ text: 'В меню', callback_data: 'tg:admin:home' }],
              ],
            },
          }, sourceMessageId);
          return;
        }
        await this.__notifySingleAdminAboutRequest(chatId, request, { targetMessageId: sourceMessageId });
        return;
      }

      if (callbackAction.action === 'admin_view_user') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю пользователя.');
        await this.__sendAdminUserDetails(chatId, String(callbackAction.payload.telegramUserId), null, { targetMessageId: sourceMessageId });
        return;
      }

      if (callbackAction.action === 'admin_toggle_multi_device') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        const user = await this.store.getTelegramUser(telegramUserId);
        if (!user) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Пользователь не найден.');
          return;
        }

        await this.store.setAllowMultiDevice(telegramUserId, !user.allowMultiDevice, fromId);
        await this.store.deleteCallbackAction(callbackId).catch(() => {});
        await this.__answerCallbackQuery(callbackQuery.id, user.allowMultiDevice ? 'Доп. устройства выключены.' : 'Доп. устройства включены.');
        await this.__sendAdminUserDetails(chatId, telegramUserId, 'Настройки пользователя обновлены.', { targetMessageId: sourceMessageId });
        return;
      }

      if (callbackAction.action === 'admin_toggle_block') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        const user = await this.store.getTelegramUser(telegramUserId);
        if (!user) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Пользователь не найден.');
          return;
        }

        const nextStatus = user.status === 'blocked' ? 'approved' : 'blocked';
        await this.store.setUserStatus(telegramUserId, nextStatus, fromId);
        await this.store.deleteCallbackAction(callbackId).catch(() => {});
        await this.__answerCallbackQuery(callbackQuery.id, nextStatus === 'blocked' ? 'Пользователь заблокирован.' : 'Пользователь разблокирован.');
        await this.__sendAdminUserDetails(chatId, telegramUserId, 'Статус пользователя обновлён.', { targetMessageId: sourceMessageId });
        return;
      }

      if (callbackAction.action === 'admin_send_configs') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        const user = await this.store.getTelegramUser(telegramUserId);
        if (!user) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Пользователь не найден.');
          return;
        }

        await this.__sendAccessFormatsMenu(user, {
          targetMessageId: null,
          prefixMessage: 'Выбери профиль и формат получения доступа.',
        });
        await this.__answerCallbackQuery(callbackQuery.id, 'Пользователю отправлено меню доступа.');
        return;
      }

      if (callbackAction.action === 'admin_pick_client_config') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю форматы.');
        await this.__sendAdminClientConfigActions(chatId, String(callbackAction.payload.clientId), {
          page: Number(callbackAction.payload.page || 0),
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_pick_client_route') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю маршрут.');
        await this.__sendAdminClientRoutePicker(chatId, String(callbackAction.payload.clientId), {
          page: Number(callbackAction.payload.page || 0),
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_pick_client_categories') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю категории.');
        await this.__sendAdminClientCategoryPicker(chatId, String(callbackAction.payload.clientId), {
          page: Number(callbackAction.payload.page || 0),
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_send_client_config_text') {
        const clientId = String(callbackAction.payload.clientId);
        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю текст.');
        await this.__sendSingleClientConfig(chatId, clientId, {
          mode: 'text',
        });
        await this.__sendAdminClientConfigActions(chatId, clientId, {
          page: Number(callbackAction.payload.page || 0),
          prefixMessage: 'Текст конфига отправлен.',
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_send_client_config_file') {
        const clientId = String(callbackAction.payload.clientId);
        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю файл.');
        await this.__sendSingleClientConfig(chatId, clientId, {
          mode: 'file',
        });
        await this.__sendAdminClientConfigActions(chatId, clientId, {
          page: Number(callbackAction.payload.page || 0),
          prefixMessage: 'Файл конфига отправлен.',
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_send_client_config_qr') {
        const clientId = String(callbackAction.payload.clientId);
        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю QR.');
        await this.__sendSingleClientConfig(chatId, clientId, {
          mode: 'qr',
        });
        await this.__sendAdminClientConfigActions(chatId, clientId, {
          page: Number(callbackAction.payload.page || 0),
          prefixMessage: 'QR конфига отправлен.',
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_set_client_uplink') {
        const clientId = String(callbackAction.payload.clientId);
        const rawUplinkId = callbackAction.payload.uplinkId;
        const uplinkId = rawUplinkId === null || typeof rawUplinkId === 'undefined'
          ? null
          : String(rawUplinkId);

        await this.wireGuard.setClientUplinkAssignment({
          clientId,
          uplinkId,
        });
        await this.__answerCallbackQuery(callbackQuery.id, uplinkId ? 'Маршрут обновлён.' : 'Возврат на основной интернет.');
        await this.__sendAdminClientRoutePicker(chatId, clientId, {
          page: Number(callbackAction.payload.page || 0),
          prefixMessage: 'Маршрут обновлён.',
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_toggle_client_category') {
        const clientId = String(callbackAction.payload.clientId);
        const categoryId = String(callbackAction.payload.categoryId);
        const enabled = callbackAction.payload.enabled === true;

        await this.wireGuard.toggleClientRoutingCategory({
          clientId,
          categoryId,
          enabled,
        });

        await this.__answerCallbackQuery(callbackQuery.id, enabled ? 'Категория включена.' : 'Категория выключена.');
        await this.__sendAdminClientCategoryPicker(chatId, clientId, {
          page: Number(callbackAction.payload.page || 0),
          prefixMessage: 'Категории обновлены.',
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'admin_revoke_subscription') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        const user = await this.store.getTelegramUser(telegramUserId);
        if (!user) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Пользователь не найден.');
          return;
        }

        const updatedUser = await this.userAccess.revokeSubscription({
          telegramUserId,
          adminTelegramUserId: fromId,
        });
        await this.store.deleteCallbackAction(callbackId).catch(() => {});
        await this.__answerCallbackQuery(callbackQuery.id, 'Подписка отозвана.');
        await this.__sendAdminUserDetails(chatId, telegramUserId, 'Подписка отозвана, связанные профили отключены.', { targetMessageId: sourceMessageId });
        await this.__sendApprovedUserHome(updatedUser, 'Подписка отозвана администратором. Доступ остановлен.').catch(() => {});
        return;
      }

      if (callbackAction.action === 'admin_reply_support') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        const user = await this.store.getTelegramUser(telegramUserId);
        if (!user) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Пользователь не найден.');
          return;
        }

        await this.store.setBotState(`support_reply:${fromId}`, telegramUserId);
        await this.__answerCallbackQuery(callbackQuery.id, 'Напиши ответ следующим сообщением.');
        await this.__renderMessage(chatId, [
          'Режим ответа в поддержку',
          '',
          `Следующее сообщение уйдёт пользователю ${telegramUserId}.`,
          'Для отмены отправь /cancel',
        ].join('\n'), {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'В меню', callback_data: 'tg:admin:home' }],
            ],
          },
        }, sourceMessageId);
        return;
      }

      if (callbackAction.action === 'admin_view_subscription_request') {
        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю оплату.');
        await this.__sendAdminSingleSubscriptionRequest(chatId, String(callbackAction.payload.requestId), { targetMessageId: sourceMessageId });
        return;
      }

      if (callbackAction.action === 'admin_approve_subscription_request') {
        const requestId = String(callbackAction.payload.requestId);
        const request = await this.store.getSubscriptionRequest(requestId);
        if (!request || request.status !== 'pending') {
          await this.__answerCallbackQuery(callbackQuery.id, 'Заявка на оплату уже обработана.');
          return;
        }

        const user = await this.userAccess.approveSubscriptionRequest({
          requestId,
          adminTelegramUserId: fromId,
        });
        await this.__answerCallbackQuery(callbackQuery.id, 'Оплата подтверждена.');
        await this.__sendAdminSingleSubscriptionRequest(chatId, requestId, {
          targetMessageId: sourceMessageId,
          prefixMessage: 'Оплата подтверждена.',
        });
        await this.__sendApprovedUserHome(user, `Подписка продлена на ${TELEGRAM_SUBSCRIPTION_DURATION_DAYS} дней.`);
        return;
      }

      if (callbackAction.action === 'admin_reject_subscription_request') {
        const requestId = String(callbackAction.payload.requestId);
        await this.store.rejectSubscriptionRequest(requestId, fromId);
        await this.__answerCallbackQuery(callbackQuery.id, 'Оплата отклонена.');
        await this.__sendAdminSingleSubscriptionRequest(chatId, requestId, {
          targetMessageId: sourceMessageId,
          prefixMessage: 'Оплата отклонена.',
        });
        return;
      }

      if (callbackAction.action === 'user_pick_client_for_access') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Выбери формат.');
        await this.__sendAccessFormatPicker({
          telegramUser,
          clientId: String(callbackAction.payload.clientId),
          targetMessageId: sourceMessageId,
        });
        return;
      }

      if (callbackAction.action === 'user_send_config_text') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю текст.');
        await this.__sendSingleClientConfig(telegramUser.chatId, String(callbackAction.payload.clientId), {
          mode: 'text',
        });
        return;
      }

      if (callbackAction.action === 'user_send_config_file') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю файл.');
        await this.__sendSingleClientConfig(telegramUser.chatId, String(callbackAction.payload.clientId), {
          mode: 'file',
        });
        return;
      }

      if (callbackAction.action === 'user_send_config_qr') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю QR.');
        await this.__sendSingleClientConfig(telegramUser.chatId, String(callbackAction.payload.clientId), {
          mode: 'qr',
        });
        return;
      }

      await this.__answerCallbackQuery(callbackQuery.id, 'Неизвестное действие.');
      return;
    }

    if (data.startsWith('tg:reject:')) {
      const requestId = data.replace('tg:reject:', '');
      await this.store.rejectRequest(requestId, fromId);
      await this.__answerCallbackQuery(callbackQuery.id, 'Заявка отклонена.');
      await this.__renderMessage(chatId, `Заявка ${requestId} отклонена.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К заявкам', callback_data: 'tg:admin:pending' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, sourceMessageId);
    }
  }

  async __handleUserCallbackQuery(callbackQuery, {
    data,
    fromId,
  }) {
    const telegramUser = await this.store.getTelegramUser(fromId);
    if (!telegramUser || telegramUser.status !== 'approved') {
      return;
    }

    if (data === 'tg:user:home') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю меню.');
      await this.__sendApprovedUserHome(telegramUser, null, { targetMessageId: callbackQuery.message?.message_id });
      return;
    }

    if (data === 'tg:user:status') {
      const links = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
      const subscriptionState = this.userAccess.getSubscriptionState(telegramUser, (value) => this.__formatTelegramDate(value));
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю статус.');
      await this.__sendApprovedUserHome(telegramUser, [
        `Telegram ID: ${telegramUser.telegramUserId}`,
        `Username: ${telegramUser.username || '-'}`,
        `Status: ${telegramUser.status}`,
        `Subscription: ${subscriptionState.label}`,
        `Multi-device: ${telegramUser.allowMultiDevice ? 'on' : 'off'}`,
        `Linked profiles: ${links.length}`,
      ].join('\n'), { targetMessageId: callbackQuery.message?.message_id });
      return;
    }

    if (data === 'tg:user:subscription') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю подписку.');
      await this.__sendSubscriptionMenu(telegramUser, {
        targetMessageId: callbackQuery.message?.message_id,
      });
      return;
    }

    if (data === 'tg:user:instructions') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю инструкцию.');
      await this.__sendInstallInstructions(telegramUser, {
        targetMessageId: callbackQuery.message?.message_id,
      });
      return;
    }

    if (data === 'tg:user:support') {
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю контакты поддержки.');
      await this.__sendSupportMenu(telegramUser, {
        targetMessageId: callbackQuery.message?.message_id,
      });
      return;
    }

    if (data === 'tg:user:support_compose') {
      await this.store.setBotState(`support_compose:${telegramUser.telegramUserId}`, '1');
      await this.__answerCallbackQuery(callbackQuery.id, 'Напиши сообщение следующим сообщением.');
      await this.__renderMessage(telegramUser.chatId, [
        'Поддержка',
        '',
        'Напиши следующим сообщением, что произошло.',
        'Для отмены отправь /cancel',
      ].join('\n'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'В меню', callback_data: 'tg:user:home' }],
          ],
        },
      }, callbackQuery.message?.message_id);
      return;
    }

    if (data === 'tg:user:route') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
        await this.__sendSubscriptionMenu(telegramUser, {
          targetMessageId: callbackQuery.message?.message_id,
          prefixMessage: 'Без активной подписки настройка маршрутов недоступна.',
        });
        return;
      }
      await this.__answerCallbackQuery(callbackQuery.id, 'Выбери профиль.');
      await this.__sendRouteClientPicker(telegramUser, {
        targetMessageId: callbackQuery.message?.message_id,
      });
      return;
    }

    if (data === 'tg:user:categories') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
        await this.__sendSubscriptionMenu(telegramUser, {
          targetMessageId: callbackQuery.message?.message_id,
          prefixMessage: 'Без активной подписки категории недоступны.',
        });
        return;
      }
      await this.__answerCallbackQuery(callbackQuery.id, 'Выбери профиль.');
      await this.__sendCategoryClientPicker(telegramUser, {
        targetMessageId: callbackQuery.message?.message_id,
      });
      return;
    }

    if (data === 'tg:user:configs') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
        await this.__sendSubscriptionMenu(telegramUser, {
          targetMessageId: callbackQuery.message?.message_id,
          prefixMessage: 'Без активной подписки доступ к конфигам закрыт.',
        });
        return;
      }
      await this.__answerCallbackQuery(callbackQuery.id, 'Открываю доступ.');
      await this.__sendAccessFormatsMenu(telegramUser, {
        targetMessageId: callbackQuery.message?.message_id,
      });
      return;
    }

    if (data.startsWith('tg:callback:')) {
      const callbackId = data.replace('tg:callback:', '');
      const callbackAction = await this.store.getCallbackAction(callbackId);
      if (!callbackAction) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Действие устарело. Открой список заново.');
        return;
      }
      if (callbackAction.actorTelegramUserId && String(callbackAction.actorTelegramUserId) !== String(fromId)) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Эта кнопка создана для другой сессии.');
        return;
      }

      if (callbackAction.action === 'user_pick_client_for_access') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки доступ к конфигам закрыт.',
          });
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Выбери формат.');
        await this.__sendAccessFormatPicker({
          telegramUser,
          clientId: String(callbackAction.payload.clientId),
          targetMessageId: callbackQuery.message?.message_id,
        });
        return;
      }

      if (callbackAction.action === 'user_pick_client_for_route') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки настройка маршрутов недоступна.',
          });
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Выбери туннель.');
        await this.__sendRouteUplinkPicker({
          telegramUser,
          clientId: String(callbackAction.payload.clientId),
          targetMessageId: callbackQuery.message?.message_id,
        });
        return;
      }

      if (callbackAction.action === 'user_pick_client_for_categories') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки категории недоступны.',
          });
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Открываю категории.');
        await this.__sendClientCategoryPicker({
          telegramUser,
          clientId: String(callbackAction.payload.clientId),
          targetMessageId: callbackQuery.message?.message_id,
        });
        return;
      }

      if (callbackAction.action === 'user_toggle_client_category') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки категории недоступны.',
          });
          return;
        }

        const clientId = String(callbackAction.payload.clientId);
        const categoryId = String(callbackAction.payload.categoryId);
        const enabled = callbackAction.payload.enabled === true;

        await this.wireGuard.toggleClientRoutingCategory({
          clientId,
          categoryId,
          enabled,
        });

        await this.__answerCallbackQuery(callbackQuery.id, enabled ? 'Категория включена.' : 'Категория выключена.');
        await this.__sendClientCategoryPicker({
          telegramUser,
          clientId,
          targetMessageId: callbackQuery.message?.message_id,
        });
        return;
      }

      if (callbackAction.action === 'user_set_client_uplink') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки настройка маршрутов недоступна.',
          });
          return;
        }

        const clientId = String(callbackAction.payload.clientId);
        const uplinkId = callbackAction.payload.uplinkId === null ? null : String(callbackAction.payload.uplinkId);
        const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
        if (!client) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Профиль не найден.');
          return;
        }

        await this.wireGuard.setClientUplinkAssignment({
          clientId,
          uplinkId,
        });

        await this.__answerCallbackQuery(callbackQuery.id, uplinkId ? 'Туннель обновлён.' : 'Возврат на основной интернет.');
        await this.__sendRouteUplinkPicker({
          telegramUser,
          clientId,
          targetMessageId: callbackQuery.message?.message_id,
          prefixMessage: uplinkId
            ? `Для профиля ${client.name} выбран uplink.`
            : `Для профиля ${client.name} выбран основной интернет.`,
        });
        return;
      }

      if (callbackAction.action === 'user_send_config_text') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки доступ к конфигам закрыт.',
          });
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю текст.');
        await this.__sendSingleClientConfig(telegramUser.chatId, String(callbackAction.payload.clientId), {
          mode: 'text',
        });
        return;
      }

      if (callbackAction.action === 'user_send_config_file') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки доступ к конфигам закрыт.',
          });
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю файл.');
        await this.__sendSingleClientConfig(telegramUser.chatId, String(callbackAction.payload.clientId), {
          mode: 'file',
        });
        return;
      }

      if (callbackAction.action === 'user_send_config_qr') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }
        if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Без активной подписки доступ к конфигам закрыт.',
          });
          return;
        }

        await this.__answerCallbackQuery(callbackQuery.id, 'Отправляю QR.');
        await this.__sendSingleClientConfig(telegramUser.chatId, String(callbackAction.payload.clientId), {
          mode: 'qr',
        });
        return;
      }

      if (callbackAction.action === 'user_create_subscription_request') {
        const telegramUserId = String(callbackAction.payload.telegramUserId);
        if (telegramUserId !== String(fromId)) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Действие недоступно.');
          return;
        }

        if (!this.subscriptionPhoneNumber) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Номер для оплаты не настроен.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: 'Администратор пока не настроил номер телефона для оплаты.',
          });
          return;
        }

        const cooldown = await this.__enforceCooldown(`subscription_request:${telegramUser.telegramUserId}`, 600);
        if (!cooldown.allowed) {
          await this.__answerCallbackQuery(callbackQuery.id, 'Слишком часто. Попробуй позже.');
          await this.__sendSubscriptionMenu(telegramUser, {
            targetMessageId: callbackQuery.message?.message_id,
            prefixMessage: `Новый запрос на подтверждение оплаты можно отправить через ${cooldown.retryAfterSeconds} сек.`,
          });
          return;
        }

        const request = await this.store.createSubscriptionRequest({
          id: crypto.randomUUID(),
          telegramUserId: telegramUser.telegramUserId,
          chatId: telegramUser.chatId,
          phoneNumber: this.subscriptionPhoneNumber,
          amountRub: TELEGRAM_SUBSCRIPTION_PRICE_RUB,
        });

        await this.__notifyAdminsAboutSubscriptionRequest(request);
        await this.__answerCallbackQuery(callbackQuery.id, 'Запрос на подтверждение оплаты отправлен.');
        await this.__sendSubscriptionMenu(telegramUser, {
          targetMessageId: callbackQuery.message?.message_id,
          prefixMessage: 'Запрос на подтверждение оплаты отправлен администратору.',
        });
        return;
      }

      await this.__answerCallbackQuery(callbackQuery.id, 'Неизвестное действие.');
      return;
    }

    if (data === 'tg:user:newdevice') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
        await this.__sendSubscriptionMenu(telegramUser, {
          targetMessageId: callbackQuery.message?.message_id,
          prefixMessage: 'Без активной подписки создание новых устройств недоступно.',
        });
        return;
      }
      if (!telegramUser.allowMultiDevice) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Доп. устройства отключены.');
        await this.__sendApprovedUserHome(telegramUser, 'Для твоего аккаунта дополнительные устройства пока не разрешены администратором.', { targetMessageId: callbackQuery.message?.message_id });
        return;
      }

      const clients = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
      const deviceName = `${telegramUser.username || telegramUser.firstName || 'device'}-${clients.length + 1}`;
      const client = await this.wireGuard.createClient({
        name: deviceName,
        expiredDate: null,
      });
      await this.store.linkClient({
        telegramUserId: telegramUser.telegramUserId,
        clientId: client.id,
      });
      await this.__answerCallbackQuery(callbackQuery.id, 'Профиль создан.');
      await this.__sendApprovedUserHome(telegramUser, `Новый профиль создан: ${client.name}. Доступ выдан.`, { targetMessageId: callbackQuery.message?.message_id });
      return;
    }

    if (data === 'tg:user:request-more-configs') {
      if (!this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value))) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Сначала оформи подписку.');
        await this.__sendSubscriptionMenu(telegramUser, {
          targetMessageId: callbackQuery.message?.message_id,
          prefixMessage: 'Без активной подписки запрос дополнительных конфигов недоступен.',
        });
        return;
      }
      if (telegramUser.allowMultiDevice) {
        await this.__answerCallbackQuery(callbackQuery.id, 'Доп. устройства уже включены.');
        await this.__sendApprovedUserHome(telegramUser, 'Для твоего аккаунта уже разрешены дополнительные устройства.', {
          targetMessageId: callbackQuery.message?.message_id,
        });
        return;
      }

      const cooldown = await this.__enforceCooldown(`multi_device_request:${telegramUser.telegramUserId}`, 600);
      if (cooldown) {
        await this.__answerCallbackQuery(callbackQuery.id, `Подожди ${cooldown} сек. перед повторным запросом.`);
        return;
      }

      await this.__notifyAdminsAboutMoreConfigsRequest(telegramUser);
      await this.__answerCallbackQuery(callbackQuery.id, 'Запрос отправлен администратору.');
      await this.__sendApprovedUserHome(telegramUser, 'Запрос на увеличение числа конфигов отправлен администратору.', {
        targetMessageId: callbackQuery.message?.message_id,
      });
      return;
    }
  }

  async __notifyAdminsAboutRequest(request) {
    for (const adminId of this.adminIds) {
      await this.__notifySingleAdminAboutRequest(adminId, request).catch((err) => {
        debug(`Failed to notify admin ${adminId}: ${err.message}`);
      });
    }
  }

  async __notifyAdminsAboutSubscriptionRequest(request) {
    for (const adminId of this.adminIds) {
      await this.__notifySingleAdminAboutSubscriptionRequest(adminId, request).catch((err) => {
        debug(`Failed to notify admin ${adminId} about subscription request: ${err.message}`);
      });
    }
  }

  async __notifyAdminsAboutMoreConfigsRequest(telegramUser) {
    for (const adminId of this.adminIds) {
      await this.__notifySingleAdminAboutMoreConfigsRequest(adminId, telegramUser).catch((err) => {
        debug(`Failed to notify admin ${adminId} about multi-device request: ${err.message}`);
      });
    }
  }

  async __sendApprovedUserHome(telegramUser, prefixMessage = null, {
    targetMessageId = null,
  } = {}) {
    const subscriptionState = this.userAccess.getSubscriptionState(telegramUser, (value) => this.__formatTelegramDate(value));
    const text = [
      prefixMessage || 'Доступ выдан.',
      '',
      `Подписка: ${subscriptionState.label}`,
      'Управление аккаунтом:',
      'Выбери действие кнопками ниже.',
    ].join('\n');

    await this.__renderMessage(telegramUser.chatId, text, {
      reply_markup: {
        inline_keyboard: this.__buildApprovedUserKeyboard(telegramUser),
      },
    }, targetMessageId);
  }

  async __sendSupportMenu(telegramUser, {
    targetMessageId = null,
  } = {}) {
    const text = [
      'Поддержка',
      '',
      'Напиши в поддержку через бота. Сообщение придёт администратору.',
    ].join('\n');

    await this.__renderMessage(telegramUser.chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Написать в поддержку', callback_data: 'tg:user:support_compose' }],
          [{ text: 'В меню', callback_data: 'tg:user:home' }],
        ],
      },
    }, targetMessageId);
  }

  async __sendInstallInstructions(telegramUser, {
    targetMessageId = null,
  } = {}) {
    const text = [
      'Инструкция по подключению',
      '',
      'Android',
      '1. Открой Google Play: https://play.google.com/store/apps/details?id=org.amnezia.vpn',
      '2. Найди приложение AmneziaVPN.',
      '3. Установи приложение.',
      '4. В боте нажми "Получить доступ" и импортируй конфиг по QR, файлом или текстом.',
      '5. Разреши создание VPN-подключения и нажми "Подключить".',
      '',
      'iPhone / iPad',
      '1. Открой App Store: https://apps.apple.com/us/app/amneziavpn/id1600529900',
      '2. Найди приложение AmneziaVPN.',
      '3. Установи приложение.',
      '4. В боте нажми "Получить доступ" и импортируй конфиг по QR, файлом или текстом.',
      '5. Разреши VPN в iOS и нажми "Подключить".',
      '6. Если приложение недоступно в российском App Store: https://docs.amnezia.org/ru/documentation/instructions/amnezia-on-ios-in-russia/',
      '',
      'Если приложение недоступно или что-то не работает, нажми "Связаться с поддержкой".',
    ].join('\n');

    await this.__renderMessage(telegramUser.chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Android / Google Play', url: 'https://play.google.com/store/apps/details?id=org.amnezia.vpn' }],
          [{ text: 'iPhone / App Store', url: 'https://apps.apple.com/us/app/amneziavpn/id1600529900' }],
          [{ text: 'iPhone в России', url: 'https://docs.amnezia.org/ru/documentation/instructions/amnezia-on-ios-in-russia/' }],
          [{ text: 'Получить доступ', callback_data: 'tg:user:configs' }],
          [{ text: 'Связаться с поддержкой', callback_data: 'tg:user:support' }],
          [{ text: 'В меню', callback_data: 'tg:user:home' }],
        ],
      },
    }, targetMessageId);
  }

  async __forwardSupportMessageFromUser(telegramUser, text) {
    const lines = [
      'Новое сообщение в поддержку',
      `Telegram ID: ${telegramUser.telegramUserId}`,
      `Username: ${telegramUser.username || '-'}`,
      `Name: ${[telegramUser.firstName, telegramUser.lastName].filter(Boolean).join(' ') || '-'}`,
      '',
      text,
    ].join('\n');

    for (const adminId of this.adminIds) {
      const replyToken = await this.__createCallbackToken('admin_reply_support', {
        telegramUserId: telegramUser.telegramUserId,
      }, adminId);

      await this.__sendMessage(adminId, lines, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Ответить', callback_data: `tg:callback:${replyToken}` }],
          ],
        },
      }).catch((err) => {
        debug(`Failed to notify admin ${adminId} about support message: ${err.message}`);
      });
    }

    await this.store.logAction({
      telegramUserId: telegramUser.telegramUserId,
      action: 'support_message',
      details: JSON.stringify({
        message: text,
      }),
    });
  }

  async __sendAdminHome(chatId, prefixMessage = null, {
    targetMessageId = null,
    adminProfile = null,
  } = {}) {
    const text = [
      prefixMessage || 'Панель администратора Telegram.',
      '',
      'Выбери раздел кнопками ниже.',
    ].join('\n');

    await this.__renderMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Заявки', callback_data: 'tg:admin:pending' },
            { text: 'Пользователи', callback_data: 'tg:admin:users' },
          ],
          [
            { text: 'Мой профиль', callback_data: 'tg:admin:self' },
          ],
          [
            { text: 'Конфиги', callback_data: 'tg:admin:configs' },
            { text: 'Оплаты', callback_data: 'tg:admin:subscriptions' },
            { text: 'Аудит', callback_data: 'tg:admin:audit' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __sendAdminPendingList(chatId, {
    targetMessageId = null,
  } = {}) {
    const pending = await this.store.listPendingRequests();
    if (pending.length === 0) {
      await this.__sendAdminHome(chatId, 'Ожидающих заявок нет.', { targetMessageId });
      return;
    }

    const keyboard = [];
    for (const request of pending.slice(0, 20)) {
      const token = await this.__createCallbackToken('admin_view_request', {
        requestId: request.id,
      }, chatId);
      keyboard.push([
        {
          text: `${request.username || request.firstName || request.telegramUserId} (${request.id.slice(0, 8)})`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    keyboard.push([
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    await this.__renderMessage(chatId, [
      `Ожидающих заявок: ${pending.length}`,
      'Выбери заявку кнопкой ниже.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendAdminUsersList(chatId, page = 0, {
    targetMessageId = null,
  } = {}) {
    const users = await this.store.listTelegramUsers();
    if (users.length === 0) {
      await this.__sendAdminHome(chatId, 'Telegram-пользователей пока нет.', { targetMessageId });
      return;
    }

    const pageSize = 8;
    const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const pageUsers = users.slice(safePage * pageSize, (safePage + 1) * pageSize);

    const keyboard = [];
    for (const user of pageUsers) {
      const token = await this.__createCallbackToken('admin_view_user', {
        telegramUserId: user.telegramUserId,
      }, chatId);
      keyboard.push([
        {
          text: `${user.username || user.firstName || user.telegramUserId} [${user.status}]`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    if (totalPages > 1) {
      const navRow = [];
      if (safePage > 0) {
        const prevToken = await this.__createCallbackToken('admin_users_page', {
          page: safePage - 1,
        }, chatId);
        navRow.push({ text: '← Назад', callback_data: `tg:callback:${prevToken}` });
      }
      if (safePage < totalPages - 1) {
        const nextToken = await this.__createCallbackToken('admin_users_page', {
          page: safePage + 1,
        }, chatId);
        navRow.push({ text: 'Дальше →', callback_data: `tg:callback:${nextToken}` });
      }
      if (navRow.length > 0) {
        keyboard.push(navRow);
      }
    }

    keyboard.push([
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    await this.__renderMessage(chatId, [
      'Пользователи Telegram.',
      `Страница ${safePage + 1} из ${totalPages}.`,
      `Всего: ${users.length}.`,
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendAdminUserDetails(chatId, telegramUserId, prefixMessage = null, {
    targetMessageId = null,
  } = {}) {
    const user = await this.store.getTelegramUser(telegramUserId);
    if (!user) {
      await this.__renderMessage(chatId, `Пользователь не найден: ${telegramUserId}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К списку пользователей', callback_data: 'tg:admin:users' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const links = await this.store.listLinkedClients(telegramUserId);
    const toggleMultiDeviceToken = await this.__createCallbackToken('admin_toggle_multi_device', {
      telegramUserId,
    }, chatId);
    const toggleBlockToken = await this.__createCallbackToken('admin_toggle_block', {
      telegramUserId,
    }, chatId);
    const sendConfigsToken = await this.__createCallbackToken('admin_send_configs', {
      telegramUserId,
    }, chatId);
    const revokeSubscriptionToken = await this.__createCallbackToken('admin_revoke_subscription', {
      telegramUserId,
    }, chatId);

    const lines = [];
    if (prefixMessage) {
      lines.push(prefixMessage, '');
    }

    const subscriptionState = this.userAccess.getSubscriptionState(user, (value) => this.__formatTelegramDate(value));

    lines.push(
      `Telegram ID: ${user.telegramUserId}`,
      `Chat ID: ${user.chatId}`,
      `Username: ${user.username || '-'}`,
      `Name: ${[user.firstName, user.lastName].filter(Boolean).join(' ') || '-'}`,
      `Status: ${user.status}`,
      `Subscription: ${subscriptionState.label}`,
      `Multi-device: ${user.allowMultiDevice ? 'on' : 'off'}`,
      `Linked client IDs: ${links.map((link) => link.clientId).join(', ') || '-'}`
    );

    await this.__renderMessage(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: user.allowMultiDevice ? 'Выключить доп. устройства' : 'Включить доп. устройства',
              callback_data: `tg:callback:${toggleMultiDeviceToken}`,
            },
          ],
          [
            {
              text: user.status === 'blocked' ? 'Разблокировать' : 'Заблокировать',
              callback_data: `tg:callback:${toggleBlockToken}`,
            },
            {
              text: 'Отправить конфиги',
              callback_data: `tg:callback:${sendConfigsToken}`,
            },
          ],
          [
            {
              text: 'Отозвать подписку',
              callback_data: `tg:callback:${revokeSubscriptionToken}`,
            },
          ],
          [
            { text: 'К списку пользователей', callback_data: 'tg:admin:users' },
            { text: 'В меню', callback_data: 'tg:admin:home' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __sendAdminAudit(chatId, {
    targetMessageId = null,
  } = {}) {
    const items = await this.store.listRecentAuditLog(20);
    if (items.length === 0) {
      await this.__sendAdminHome(chatId, 'Журнал действий пуст.', { targetMessageId });
      return;
    }

    const lines = items.map((item) => {
      return `${item.createdAt} | ${item.action} | tg=${item.telegramUserId || '-'} | admin=${item.adminTelegramUserId || '-'}`;
    });

    await this.__renderMessage(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'В меню', callback_data: 'tg:admin:home' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __sendAdminConfigsList(chatId, page = 0, {
    targetMessageId = null,
  } = {}) {
    const clients = await this.wireGuard.getClients();
    if (clients.length === 0) {
      await this.__sendAdminHome(chatId, 'WireGuard-профилей пока нет.', { targetMessageId });
      return;
    }

    const sortedClients = [...clients].sort((a, b) => a.name.localeCompare(b.name));
    const pageSize = 8;
    const totalPages = Math.max(1, Math.ceil(sortedClients.length / pageSize));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const pageClients = sortedClients.slice(safePage * pageSize, (safePage + 1) * pageSize);

    const keyboard = [];
    for (const client of pageClients) {
      const token = await this.__createCallbackToken('admin_pick_client_config', {
        clientId: client.id,
        page: safePage,
      }, chatId);
      keyboard.push([
        {
          text: `${client.name} (${client.address})`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    if (totalPages > 1) {
      const navRow = [];
      if (safePage > 0) {
        const prevToken = await this.__createCallbackToken('admin_configs_page', {
          page: safePage - 1,
        }, chatId);
        navRow.push({ text: '← Назад', callback_data: `tg:callback:${prevToken}` });
      }
      if (safePage < totalPages - 1) {
        const nextToken = await this.__createCallbackToken('admin_configs_page', {
          page: safePage + 1,
        }, chatId);
        navRow.push({ text: 'Дальше →', callback_data: `tg:callback:${nextToken}` });
      }
      if (navRow.length > 0) {
        keyboard.push(navRow);
      }
    }

    keyboard.push([
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    await this.__renderMessage(chatId, [
      'WireGuard-профили.',
      `Страница ${safePage + 1} из ${totalPages}.`,
      `Всего профилей: ${sortedClients.length}.`,
      'Выбери профиль, чтобы отправить конфиг текстом, файлом или QR.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  __getAdminProfilePayload(source) {
    const from = source?.from || source?.message?.from || null;
    if (!from) {
      return null;
    }

    return {
      username: from.username || '',
      firstName: from.first_name || '',
      lastName: from.last_name || '',
    };
  }

  __buildAdminClientName(telegramUserId, profile = {}) {
    const source = profile.username || profile.firstName || profile.lastName || `admin-${telegramUserId}`;
    const normalized = String(source)
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_.-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);

    return `admin-${normalized || telegramUserId}`.slice(0, 32);
  }

  async __ensureAdminOwnProfile({
    telegramUserId,
    chatId,
    profile = null,
  }) {
    const resolvedProfile = profile || {};
    let telegramUser = await this.store.upsertApprovedUser({
      telegramUserId,
      chatId,
      username: resolvedProfile.username || '',
      firstName: resolvedProfile.firstName || '',
      lastName: resolvedProfile.lastName || '',
      allowMultiDevice: true,
      adminTelegramUserId: telegramUserId,
    });

    const linkedClientIds = await this.store.listLinkedClientIds(telegramUserId);
    if (linkedClientIds.length > 0) {
      return telegramUser;
    }

    const client = await this.wireGuard.createClient({
      name: this.__buildAdminClientName(telegramUserId, resolvedProfile),
      expiredDate: null,
    });
    await this.store.linkClient({
      telegramUserId,
      clientId: client.id,
      adminTelegramUserId: telegramUserId,
    });

    telegramUser = await this.store.getTelegramUser(telegramUserId);
    return telegramUser;
  }

  async __sendAdminOwnProfile(chatId, telegramUser, {
    prefixMessage = null,
    targetMessageId = null,
  } = {}) {
    const linkedClientIds = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
    if (linkedClientIds.length === 0) {
      await this.__renderMessage(chatId, 'У администратора пока нет привязанного VPN-профиля.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const client = await this.wireGuard.getClient({ clientId: linkedClientIds[0] }).catch(() => null);
    if (!client) {
      await this.__renderMessage(chatId, 'VPN-профиль администратора не найден.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const configToken = await this.__createCallbackToken('admin_pick_client_config', {
      clientId: client.id,
      page: 0,
    }, chatId);

    const lines = [];
    if (prefixMessage) {
      lines.push(prefixMessage, '');
    }
    lines.push(
      'Профиль администратора',
      `Профиль: ${client.name}`,
      `Адрес: ${client.address}`
    );

    await this.__renderMessage(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Получить конфиг', callback_data: `tg:callback:${configToken}` }],
          [{ text: 'В меню', callback_data: 'tg:admin:home' }],
        ],
      },
    }, targetMessageId);
  }

  async __sendAdminClientConfigActions(chatId, clientId, {
    page = 0,
    prefixMessage = null,
    targetMessageId = null,
  } = {}) {
    const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
    if (!client) {
      await this.__renderMessage(chatId, 'Профиль не найден.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К конфигам', callback_data: 'tg:admin:configs' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const textToken = await this.__createCallbackToken('admin_send_client_config_text', {
      clientId,
      page,
    }, chatId);
    const fileToken = await this.__createCallbackToken('admin_send_client_config_file', {
      clientId,
      page,
    }, chatId);
    const qrToken = await this.__createCallbackToken('admin_send_client_config_qr', {
      clientId,
      page,
    }, chatId);
    const routeToken = await this.__createCallbackToken('admin_pick_client_route', {
      clientId,
      page,
    }, chatId);
    const categoriesToken = await this.__createCallbackToken('admin_pick_client_categories', {
      clientId,
      page,
    }, chatId);
    const backToken = await this.__createCallbackToken('admin_configs_page', {
      page,
    }, chatId);

    const lines = [];
    if (prefixMessage) {
      lines.push(prefixMessage, '');
    }
    lines.push(
      `Профиль: ${client.name}`,
      `Адрес: ${client.address}`,
      'Выбери формат отправки.'
    );

    await this.__renderMessage(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Текст', callback_data: `tg:callback:${textToken}` },
            { text: 'Файл', callback_data: `tg:callback:${fileToken}` },
            { text: 'QR', callback_data: `tg:callback:${qrToken}` },
          ],
          [
            { text: 'Маршрут', callback_data: `tg:callback:${routeToken}` },
            { text: 'Категории', callback_data: `tg:callback:${categoriesToken}` },
          ],
          [
            { text: 'К конфигам', callback_data: `tg:callback:${backToken}` },
            { text: 'В меню', callback_data: 'tg:admin:home' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __sendAdminClientRoutePicker(chatId, clientId, {
    page = 0,
    prefixMessage = null,
    targetMessageId = null,
  } = {}) {
    const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
    if (!client) {
      await this.__renderMessage(chatId, 'Профиль не найден.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К конфигам', callback_data: 'tg:admin:configs' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const uplinks = await this.wireGuard.getUplinkSettingsList();
    const assignedUplinkId = await this.wireGuard.getClientUplinkAssignment(clientId);
    const enabledUplinks = uplinks.filter((uplink) => uplink.enabled);
    const assignedUplink = enabledUplinks.find((uplink) => uplink.id === assignedUplinkId) || null;

    const keyboard = [];
    const mainToken = await this.__createCallbackToken('admin_set_client_uplink', {
      clientId,
      uplinkId: null,
      page,
    }, chatId);

    keyboard.push([
      {
        text: assignedUplinkId ? 'Основной интернет' : 'Основной интернет ✓',
        callback_data: `tg:callback:${mainToken}`,
      },
    ]);

    for (const uplink of enabledUplinks) {
      const token = await this.__createCallbackToken('admin_set_client_uplink', {
        clientId,
        uplinkId: uplink.id,
        page,
      }, chatId);

      keyboard.push([
        {
          text: uplink.id === assignedUplinkId ? `${uplink.name} ✓` : uplink.name,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    const backToken = await this.__createCallbackToken('admin_pick_client_config', {
      clientId,
      page,
    }, chatId);

    keyboard.push([
      { text: 'К профилю', callback_data: `tg:callback:${backToken}` },
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    await this.__renderMessage(chatId, [
      prefixMessage || `Профиль: ${client.name}`,
      `Текущий маршрут: ${assignedUplink ? assignedUplink.name : 'основной интернет'}`,
      enabledUplinks.length > 0
        ? 'Выбери, через какой туннель этот профиль будет выходить наружу.'
        : 'Доступных uplink-туннелей сейчас нет. Можно выбрать только основной интернет.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendAdminClientCategoryPicker(chatId, clientId, {
    page = 0,
    prefixMessage = null,
    targetMessageId = null,
  } = {}) {
    const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
    if (!client) {
      await this.__renderMessage(chatId, 'Профиль не найден.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К конфигам', callback_data: 'tg:admin:configs' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const categories = await this.wireGuard.getClientRoutingCategories(clientId);
    const enabledCategories = categories.filter((category) => category.enabled);

    const keyboard = [];
    for (const category of enabledCategories) {
      const token = await this.__createCallbackToken('admin_toggle_client_category', {
        clientId,
        categoryId: category.id,
        enabled: !category.active,
        page,
      }, chatId);

      keyboard.push([
        {
          text: category.active ? `Выключить: ${category.name}` : `Включить: ${category.name}`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    const backToken = await this.__createCallbackToken('admin_pick_client_config', {
      clientId,
      page,
    }, chatId);

    keyboard.push([
      { text: 'К профилю', callback_data: `tg:callback:${backToken}` },
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    const lines = [
      prefixMessage || `Профиль: ${client.name}`,
      'Категории доменных правил:',
    ];

    if (enabledCategories.length === 0) {
      lines.push('Нет доступных категорий. Их нужно настроить в веб-интерфейсе.');
    } else {
      for (const category of enabledCategories) {
        lines.push(`${category.active ? 'ON' : 'OFF'} ${category.name}`);
      }
    }

    await this.__renderMessage(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendAdminSubscriptionRequests(chatId, {
    targetMessageId = null,
  } = {}) {
    const requests = await this.store.listPendingSubscriptionRequests();
    if (requests.length === 0) {
      await this.__sendAdminHome(chatId, 'Ожидающих подтверждений оплаты нет.', { targetMessageId });
      return;
    }

    const keyboard = [];
    for (const request of requests.slice(0, 20)) {
      const token = await this.__createCallbackToken('admin_view_subscription_request', {
        requestId: request.id,
      }, chatId);
      keyboard.push([
        {
          text: `${request.telegramUserId} · ${request.amountRub} ₽`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    keyboard.push([
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    await this.__renderMessage(chatId, [
      `Ожидающих подтверждений оплаты: ${requests.length}`,
      'Выбери заявку кнопкой ниже.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendAdminSingleSubscriptionRequest(chatId, requestId, {
    targetMessageId = null,
    prefixMessage = null,
  } = {}) {
    const request = await this.store.getSubscriptionRequest(requestId);
    if (!request) {
      await this.__renderMessage(chatId, 'Заявка на оплату не найдена.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К оплатам', callback_data: 'tg:admin:subscriptions' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const approveToken = request.status === 'pending'
      ? await this.__createCallbackToken('admin_approve_subscription_request', { requestId }, chatId)
      : null;
    const rejectToken = request.status === 'pending'
      ? await this.__createCallbackToken('admin_reject_subscription_request', { requestId }, chatId)
      : null;

    const keyboard = [];
    if (request.status === 'pending') {
      keyboard.push([
        { text: 'Подтвердить оплату', callback_data: `tg:callback:${approveToken}` },
        { text: 'Отклонить', callback_data: `tg:callback:${rejectToken}` },
      ]);
    }
    keyboard.push([
      { text: 'К оплатам', callback_data: 'tg:admin:subscriptions' },
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    const lines = [];
    if (prefixMessage) {
      lines.push(prefixMessage, '');
    }
    lines.push(
      `Payment request: ${request.id}`,
      `Telegram ID: ${request.telegramUserId}`,
      `Amount: ${request.amountRub} ₽`,
      `Phone: ${request.phoneNumber || '-'}`,
      `Status: ${request.status}`,
      `Requested: ${request.requestedAt}`,
      `Resolved: ${request.resolvedAt || '-'}`
    );

    await this.__renderMessage(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendSubscriptionMenu(telegramUser, {
    targetMessageId = null,
    prefixMessage = null,
  } = {}) {
    const subscriptionState = this.userAccess.getSubscriptionState(telegramUser, (value) => this.__formatTelegramDate(value));
    const pendingRequest = await this.store.getPendingSubscriptionRequestForTelegramUser(telegramUser.telegramUserId);

    const lines = [];
    if (prefixMessage) {
      lines.push(prefixMessage, '');
    }

    lines.push(
      `Подписка: ${subscriptionState.label}`,
      `Стоимость: ${TELEGRAM_SUBSCRIPTION_PRICE_RUB} ₽ / ${TELEGRAM_SUBSCRIPTION_DURATION_DAYS} дней`,
      `Льготный период: ${TELEGRAM_SUBSCRIPTION_GRACE_DAYS} дней`
    );

    if (this.subscriptionRecipientName) {
      lines.push(`Получатель: ${this.subscriptionRecipientName}`);
    }
    if (this.subscriptionBankName) {
      lines.push(`Банк: ${this.subscriptionBankName}`);
    }
    lines.push(`Номер для оплаты: ${this.subscriptionPhoneNumber || 'не настроен'}`);
    if (this.subscriptionPaymentNote) {
      lines.push(`Комментарий: ${this.subscriptionPaymentNote}`);
    }

    if (telegramUser.subscriptionExpiresAt) {
      lines.push(`Оплачено до: ${this.__formatTelegramDate(telegramUser.subscriptionExpiresAt)}`);
    }
    if (telegramUser.subscriptionGraceUntil) {
      lines.push(`Работает до: ${this.__formatTelegramDate(telegramUser.subscriptionGraceUntil)}`);
    }
    if (pendingRequest) {
      lines.push('', 'Ожидается подтверждение последнего перевода администратором.');
    } else {
      lines.push('', 'После перевода нажми кнопку "Я перевел".');
    }

    const keyboard = [];
    if (!pendingRequest) {
      const token = await this.__createCallbackToken('user_create_subscription_request', {
        telegramUserId: telegramUser.telegramUserId,
      }, telegramUser.telegramUserId);
      keyboard.push([
        { text: 'Я перевел', callback_data: `tg:callback:${token}` },
      ]);
    }
    keyboard.push([
      { text: 'В меню', callback_data: 'tg:user:home' },
    ]);

    await this.__renderMessage(telegramUser.chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  __buildApprovedUserKeyboard(telegramUser) {
    const hasOperationalSubscription = this.userAccess.hasOperationalSubscription(telegramUser, (value) => this.__formatTelegramDate(value));
    const keyboard = [
      [
        { text: 'Получить доступ', callback_data: 'tg:user:configs' },
        { text: 'Мой статус', callback_data: 'tg:user:status' },
      ],
    ];

    keyboard.push([
      { text: 'Купить подписку', callback_data: 'tg:user:subscription' },
    ]);

    keyboard.push([
      { text: 'Инструкция', callback_data: 'tg:user:instructions' },
      { text: 'Связаться с поддержкой', callback_data: 'tg:user:support' },
    ]);

    if (hasOperationalSubscription) {
      keyboard.push([
        { text: 'Маршрут наружу', callback_data: 'tg:user:route' },
        { text: 'Категории', callback_data: 'tg:user:categories' },
      ]);

      if (telegramUser.allowMultiDevice) {
        keyboard.push([
          { text: 'Новое устройство', callback_data: 'tg:user:newdevice' },
        ]);
      } else {
        keyboard.push([
          { text: 'Запросить доп. конфиги', callback_data: 'tg:user:request-more-configs' },
        ]);
      }
    }

    keyboard.push([
      { text: 'Обновить меню', callback_data: 'tg:user:home' },
    ]);

    return keyboard;
  }

  __formatTelegramDate(value) {
    if (!value) {
      return '-';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  async __notifySingleAdminAboutRequest(chatId, request, {
    targetMessageId = null,
  } = {}) {
    const bindExistingToken = await this.__createCallbackToken('show_bind_clients', {
      requestId: request.id,
      page: 0,
    }, chatId);

    const description = [
      'Новая Telegram-заявка на доступ.',
      `Request ID: ${request.id}`,
      `Telegram ID: ${request.telegramUserId}`,
      `Username: ${request.username || '-'}`,
      `Name: ${[request.firstName, request.lastName].filter(Boolean).join(' ') || '-'}`,
    ].join('\n');

    await this.__renderMessage(chatId, description, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Создать новый профиль', callback_data: `tg:approve_create:${request.id}` },
            { text: 'Привязать к существующему', callback_data: `tg:callback:${bindExistingToken}` },
          ],
          [
            { text: 'Отклонить', callback_data: `tg:reject:${request.id}` },
            { text: 'В меню', callback_data: 'tg:admin:home' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __notifySingleAdminAboutSubscriptionRequest(chatId, request, {
    targetMessageId = null,
  } = {}) {
    const approveToken = await this.__createCallbackToken('admin_approve_subscription_request', {
      requestId: request.id,
    }, chatId);
    const rejectToken = await this.__createCallbackToken('admin_reject_subscription_request', {
      requestId: request.id,
    }, chatId);

    await this.__renderMessage(chatId, [
      'Новая заявка на подтверждение оплаты.',
      `Payment request: ${request.id}`,
      `Telegram ID: ${request.telegramUserId}`,
      `Amount: ${request.amountRub} ₽`,
      `Phone: ${request.phoneNumber || '-'}`,
      `Requested: ${request.requestedAt}`,
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Подтвердить оплату', callback_data: `tg:callback:${approveToken}` },
            { text: 'Отклонить', callback_data: `tg:callback:${rejectToken}` },
          ],
          [
            { text: 'К оплатам', callback_data: 'tg:admin:subscriptions' },
            { text: 'В меню', callback_data: 'tg:admin:home' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __notifySingleAdminAboutMoreConfigsRequest(chatId, telegramUser, {
    targetMessageId = null,
  } = {}) {
    const toggleMultiDeviceToken = await this.__createCallbackToken('admin_toggle_multi_device', {
      telegramUserId: telegramUser.telegramUserId,
    }, chatId);
    const links = await this.store.listLinkedClients(telegramUser.telegramUserId);

    await this.__renderMessage(chatId, [
      'Запрос на увеличение числа конфигов.',
      `Telegram ID: ${telegramUser.telegramUserId}`,
      `Username: ${telegramUser.username || '-'}`,
      `Name: ${[telegramUser.firstName, telegramUser.lastName].filter(Boolean).join(' ') || '-'}`,
      `Linked profiles: ${links.length}`,
      'Пользователь просит разрешить дополнительные устройства.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Включить доп. устройства', callback_data: `tg:callback:${toggleMultiDeviceToken}` },
          ],
          [
            { text: 'К пользователям', callback_data: 'tg:admin:users' },
            { text: 'В меню', callback_data: 'tg:admin:home' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __sendUserConfigs(telegramUser) {
    const clientIds = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
    if (clientIds.length === 0) {
      await this.__sendMessage(telegramUser.chatId, 'За твоим аккаунтом пока не закреплено ни одного VPN-профиля.');
      return;
    }

    for (const clientId of clientIds) {
      await this.__sendSingleClientConfig(telegramUser.chatId, clientId, null);
    }
  }

  async __sendAccessFormatsMenu(telegramUser, {
    targetMessageId = null,
    prefixMessage = null,
  } = {}) {
    const clientIds = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
    if (clientIds.length === 0) {
      await this.__renderMessage(telegramUser.chatId, 'За твоим аккаунтом пока не закреплено ни одного VPN-профиля.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'В меню', callback_data: 'tg:user:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const keyboard = [];
    for (const clientId of clientIds) {
      const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
      if (!client) {
        continue;
      }

      const token = await this.__createCallbackToken('user_pick_client_for_access', {
        telegramUserId: telegramUser.telegramUserId,
        clientId,
      }, telegramUser.telegramUserId);
      keyboard.push([
        {
          text: `${client.name} (${client.address})`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    keyboard.push([
      { text: 'В меню', callback_data: 'tg:user:home' },
    ]);

    await this.__renderMessage(telegramUser.chatId, [
      prefixMessage || 'Выбери профиль для получения доступа.',
      'После этого выбери формат.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendAccessFormatPicker({
    telegramUser,
    clientId,
    targetMessageId = null,
  }) {
    const client = await this.wireGuard.getClient({ clientId });
    const textToken = await this.__createCallbackToken('user_send_config_text', {
      telegramUserId: telegramUser.telegramUserId,
      clientId,
    }, telegramUser.telegramUserId);
    const fileToken = await this.__createCallbackToken('user_send_config_file', {
      telegramUserId: telegramUser.telegramUserId,
      clientId,
    }, telegramUser.telegramUserId);
    const qrToken = await this.__createCallbackToken('user_send_config_qr', {
      telegramUserId: telegramUser.telegramUserId,
      clientId,
    }, telegramUser.telegramUserId);

    await this.__renderMessage(telegramUser.chatId, [
      `Профиль: ${client.name}`,
      'Выбери формат получения доступа.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Текст', callback_data: `tg:callback:${textToken}` },
            { text: 'Файл', callback_data: `tg:callback:${fileToken}` },
            { text: 'QR', callback_data: `tg:callback:${qrToken}` },
          ],
          [
            { text: 'К профилям', callback_data: 'tg:user:configs' },
            { text: 'В меню', callback_data: 'tg:user:home' },
          ],
        ],
      },
    }, targetMessageId);
  }

  async __sendRouteClientPicker(telegramUser, {
    targetMessageId = null,
    prefixMessage = null,
  } = {}) {
    const clientIds = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
    if (clientIds.length === 0) {
      await this.__renderMessage(telegramUser.chatId, 'За твоим аккаунтом пока не закреплено ни одного VPN-профиля.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'В меню', callback_data: 'tg:user:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const keyboard = [];
    for (const clientId of clientIds) {
      const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
      if (!client) {
        continue;
      }

      const token = await this.__createCallbackToken('user_pick_client_for_route', {
        telegramUserId: telegramUser.telegramUserId,
        clientId,
      }, telegramUser.telegramUserId);

      keyboard.push([
        {
          text: `${client.name} (${client.address})`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    keyboard.push([
      { text: 'В меню', callback_data: 'tg:user:home' },
    ]);

    await this.__renderMessage(telegramUser.chatId, [
      prefixMessage || 'Выбери профиль, для которого нужно поменять маршрут наружу.',
      'Настройка применяется отдельно для каждого VPN-профиля.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendRouteUplinkPicker({
    telegramUser,
    clientId,
    targetMessageId = null,
    prefixMessage = null,
  }) {
    const client = await this.wireGuard.getClient({ clientId });
    const uplinks = await this.wireGuard.getUplinkSettingsList();
    const assignedUplinkId = await this.wireGuard.getClientUplinkAssignment(clientId);
    const enabledUplinks = uplinks.filter((uplink) => uplink.enabled);
    const assignedUplink = enabledUplinks.find((uplink) => uplink.id === assignedUplinkId) || null;

    const keyboard = [];
    const mainToken = await this.__createCallbackToken('user_set_client_uplink', {
      telegramUserId: telegramUser.telegramUserId,
      clientId,
      uplinkId: null,
    }, telegramUser.telegramUserId);

    keyboard.push([
      {
        text: assignedUplinkId ? 'Основной интернет' : 'Основной интернет ✓',
        callback_data: `tg:callback:${mainToken}`,
      },
    ]);

    for (const uplink of enabledUplinks) {
      const token = await this.__createCallbackToken('user_set_client_uplink', {
        telegramUserId: telegramUser.telegramUserId,
        clientId,
        uplinkId: uplink.id,
      }, telegramUser.telegramUserId);

      keyboard.push([
        {
          text: uplink.id === assignedUplinkId ? `${uplink.name} ✓` : uplink.name,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    keyboard.push([
      { text: 'К профилям', callback_data: 'tg:user:route' },
      { text: 'В меню', callback_data: 'tg:user:home' },
    ]);

    await this.__renderMessage(telegramUser.chatId, [
      prefixMessage || `Профиль: ${client.name}`,
      `Текущий маршрут: ${assignedUplink ? assignedUplink.name : 'основной интернет'}`,
      enabledUplinks.length > 0
        ? 'Выбери, через какой туннель этот профиль будет выходить наружу.'
        : 'Доступных uplink-туннелей сейчас нет. Можно выбрать только основной интернет.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendCategoryClientPicker(telegramUser, {
    targetMessageId = null,
    prefixMessage = null,
  } = {}) {
    const clientIds = await this.store.listLinkedClientIds(telegramUser.telegramUserId);
    if (clientIds.length === 0) {
      await this.__renderMessage(telegramUser.chatId, 'За твоим аккаунтом пока не закреплено ни одного VPN-профиля.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'В меню', callback_data: 'tg:user:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const keyboard = [];
    for (const clientId of clientIds) {
      const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
      if (!client) {
        continue;
      }

      const token = await this.__createCallbackToken('user_pick_client_for_categories', {
        telegramUserId: telegramUser.telegramUserId,
        clientId,
      }, telegramUser.telegramUserId);

      keyboard.push([
        {
          text: `${client.name} (${client.address})`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    keyboard.push([
      { text: 'В меню', callback_data: 'tg:user:home' },
    ]);

    await this.__renderMessage(telegramUser.chatId, [
      prefixMessage || 'Выбери профиль, для которого нужно настроить категории.',
      'Категории применяются отдельно к каждому VPN-профилю.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendClientCategoryPicker({
    telegramUser,
    clientId,
    targetMessageId = null,
    prefixMessage = null,
  }) {
    const client = await this.wireGuard.getClient({ clientId });
    const categories = await this.wireGuard.getClientRoutingCategories(clientId);
    const enabledCategories = categories.filter((category) => category.enabled);

    const keyboard = [];
    for (const category of enabledCategories) {
      const token = await this.__createCallbackToken('user_toggle_client_category', {
        telegramUserId: telegramUser.telegramUserId,
        clientId,
        categoryId: category.id,
        enabled: !category.active,
      }, telegramUser.telegramUserId);

      keyboard.push([
        {
          text: category.active ? `Disable: ${category.name}` : `Enable: ${category.name}`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    keyboard.push([
      { text: 'К профилям', callback_data: 'tg:user:categories' },
      { text: 'В меню', callback_data: 'tg:user:home' },
    ]);

    const lines = [
      prefixMessage || `Профиль: ${client.name}`,
      'Категории доменных правил:',
    ];

    if (enabledCategories.length === 0) {
      lines.push('Нет доступных категорий. Их должен настроить администратор в веб-интерфейсе.');
    } else {
      for (const category of enabledCategories) {
        lines.push(`${category.active ? 'ON' : 'OFF'} ${category.name}`);
      }
    }

    await this.__renderMessage(telegramUser.chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __sendSingleClientConfig(chatId, clientId, {
    prefixMessage = null,
    mode = 'all',
  } = {}) {
    const client = await this.wireGuard.getClient({ clientId });
    const config = await this.wireGuard.getClientConfiguration({ clientId });

    if (prefixMessage) {
      await this.__sendMessage(chatId, prefixMessage);
    }

    if (mode === 'text' || mode === 'all') {
      await this.__sendMessage(chatId, `<b>${escapeHtml(client.name)}</b>\n<pre>${escapeHtml(config)}</pre>`, {
        parse_mode: 'HTML',
      });
    }

    if (mode === 'file' || mode === 'all') {
      await this.__sendClientConfigDocument(chatId, client.name, config).catch((err) => {
        debug(`Failed to send config document for ${clientId}: ${err.message}`);
      });
    }

    if (mode === 'qr' || mode === 'all') {
      await this.__sendClientQrCode(chatId, client.name, config).catch((err) => {
        debug(`Failed to send QR for ${clientId}: ${err.message}`);
      });
    }
  }

  async __sendExistingProfilesPicker({
    chatId,
    requestId,
    page = 0,
    targetMessageId = null,
  }) {
    const request = await this.store.getPendingRequest(requestId);
    if (!request || request.status !== 'pending') {
      await this.__renderMessage(chatId, 'Заявка уже обработана.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К заявкам', callback_data: 'tg:admin:pending' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const clients = await this.wireGuard.getClients();
    const sortedClients = [...clients].sort((a, b) => a.name.localeCompare(b.name));
    const pageSize = 8;
    const totalPages = Math.max(1, Math.ceil(sortedClients.length / pageSize));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const pageClients = sortedClients.slice(safePage * pageSize, (safePage + 1) * pageSize);

    if (pageClients.length === 0) {
      await this.__renderMessage(chatId, 'Нет доступных профилей для привязки.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'К заявкам', callback_data: 'tg:admin:pending' }],
            [{ text: 'В меню', callback_data: 'tg:admin:home' }],
          ],
        },
      }, targetMessageId);
      return;
    }

    const keyboard = [];
    for (const client of pageClients) {
      const token = await this.__createCallbackToken('approve_link_existing', {
        requestId,
        clientId: client.id,
      }, chatId);
      keyboard.push([
        {
          text: `${client.name} (${client.address})`,
          callback_data: `tg:callback:${token}`,
        },
      ]);
    }

    if (totalPages > 1) {
      const navRow = [];
      if (safePage > 0) {
        const prevToken = await this.__createCallbackToken('show_bind_clients', {
          requestId,
          page: safePage - 1,
        }, chatId);
        navRow.push({ text: '← Назад', callback_data: `tg:callback:${prevToken}` });
      }
      if (safePage < totalPages - 1) {
        const nextToken = await this.__createCallbackToken('show_bind_clients', {
          requestId,
          page: safePage + 1,
        }, chatId);
        navRow.push({ text: 'Дальше →', callback_data: `tg:callback:${nextToken}` });
      }
      if (navRow.length > 0) {
        keyboard.push(navRow);
      }
    }

    keyboard.push([
      { text: 'К заявкам', callback_data: 'tg:admin:pending' },
      { text: 'В меню', callback_data: 'tg:admin:home' },
    ]);

    await this.__renderMessage(chatId, [
      `Выбери существующий профиль для заявки ${requestId}.`,
      `Страница ${safePage + 1} из ${totalPages}.`,
      `Всего профилей: ${sortedClients.length}.`,
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }, targetMessageId);
  }

  async __createCallbackToken(action, payload, actorTelegramUserId = null) {
    const id = crypto.randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await this.store.createCallbackAction({
      id,
      action,
      payload,
      expiresAt,
      actorTelegramUserId,
    });
    return id;
  }

  __isAdmin(telegramUserId) {
    return this.adminIds.includes(String(telegramUserId));
  }

  async __sendMessage(chatId, text, extra = {}) {
    return this.__apiCall('sendMessage', {
      chat_id: chatId,
      text,
      ...extra,
    });
  }

  async __renderMessage(chatId, text, extra = {}, messageId = null) {
    if (messageId) {
      return this.__editMessage(chatId, messageId, text, extra);
    }

    return this.__sendMessage(chatId, text, extra);
  }

  async __editMessage(chatId, messageId, text, extra = {}) {
    return this.__apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...extra,
    }).catch(async (err) => {
      if (err.message.includes('message is not modified')) {
        return null;
      }

      if (err.message.includes('message to edit not found')) {
        return this.__sendMessage(chatId, text, extra);
      }

      throw err;
    });
  }

  async __answerCallbackQuery(callbackQueryId, text) {
    return this.__apiCall('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    }).catch(() => {});
  }

  async __apiCall(method, payload) {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${this.token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const responseText = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`Telegram API ${method} failed with status ${res.statusCode}: ${data}`));
          }

          return resolve(data);
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const parsed = JSON.parse(responseText);
    if (!parsed.ok) {
      throw new ServerError(`Telegram API ${method} failed: ${parsed.description || 'Unknown error'}`, 400);
    }

    return parsed;
  }

  async __sendClientConfigDocument(chatId, clientName, config) {
    const safeName = `${String(clientName || 'client').replace(/[^A-Za-z0-9_.-]/g, '-') || 'client'}.conf`;
    return this.__apiCallMultipart('sendDocument', {
      chat_id: String(chatId),
      caption: `Конфиг ${clientName}`,
      document: {
        filename: safeName,
        contentType: 'text/plain',
        data: Buffer.from(config, 'utf8'),
      },
    });
  }

  async __sendClientQrCode(chatId, clientName, config) {
    const buffer = await QRCode.toBuffer(config, {
      type: 'png',
      width: 768,
      margin: 1,
    });

    return this.__apiCallMultipart('sendPhoto', {
      chat_id: String(chatId),
      caption: `QR ${clientName}`,
      photo: {
        filename: `${path.basename(String(clientName || 'client'))}.png`,
        contentType: 'image/png',
        data: buffer,
      },
    });
  }

  async __apiCallMultipart(method, payload) {
    const boundary = `----wgEasyTelegram${crypto.randomBytes(12).toString('hex')}`;
    const buffers = [];

    for (const [key, value] of Object.entries(payload)) {
      if (value && typeof value === 'object' && Buffer.isBuffer(value.data)) {
        buffers.push(Buffer.from(
          `--${boundary}\r\n`
          + `Content-Disposition: form-data; name="${key}"; filename="${value.filename}"\r\n`
          + `Content-Type: ${value.contentType || 'application/octet-stream'}\r\n\r\n`
        ));
        buffers.push(value.data);
        buffers.push(Buffer.from('\r\n'));
      } else {
        buffers.push(Buffer.from(
          `--${boundary}\r\n`
          + `Content-Disposition: form-data; name="${key}"\r\n\r\n`
          + `${value}\r\n`
        ));
      }
    }

    buffers.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(buffers);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${this.token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const responseText = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            return reject(new Error(`Telegram API ${method} failed with status ${res.statusCode}: ${data}`));
          }

          return resolve(data);
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const parsed = JSON.parse(responseText);
    if (!parsed.ok) {
      throw new ServerError(`Telegram API ${method} failed: ${parsed.description || 'Unknown error'}`, 400);
    }

    return parsed;
  }

};
