'use strict';

const debug = require('debug')('TelegramUserAccessService');

module.exports = class TelegramUserAccessService {

  constructor({
    wireGuard,
    store,
    subscriptionDurationDays,
    subscriptionGraceDays,
  }) {
    this.wireGuard = wireGuard;
    this.store = store;
    this.subscriptionDurationDays = subscriptionDurationDays;
    this.subscriptionGraceDays = subscriptionGraceDays;
    this.lastSubscriptionMaintenanceAt = 0;
  }

  buildClientNameFromRequest(request) {
    const source = request.username || request.firstName || request.lastName || `tg-${request.telegramUserId}`;
    const normalized = String(source)
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_.-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);

    return normalized || `tg-${request.telegramUserId}`;
  }

  getSubscriptionState(telegramUser, formatDate) {
    const now = Date.now();
    const expiresAt = telegramUser?.subscriptionExpiresAt ? new Date(telegramUser.subscriptionExpiresAt).getTime() : null;
    const graceUntil = telegramUser?.subscriptionGraceUntil ? new Date(telegramUser.subscriptionGraceUntil).getTime() : null;

    if (expiresAt && expiresAt > now) {
      return {
        code: 'active',
        label: `активна до ${formatDate(telegramUser.subscriptionExpiresAt)}`,
      };
    }

    if (graceUntil && graceUntil > now) {
      return {
        code: 'grace',
        label: `льготный период до ${formatDate(telegramUser.subscriptionGraceUntil)}`,
      };
    }

    if (expiresAt || graceUntil) {
      return {
        code: 'expired',
        label: 'истекла',
      };
    }

    return {
      code: 'missing',
      label: 'не оформлена',
    };
  }

  hasOperationalSubscription(telegramUser, formatDate) {
    const state = this.getSubscriptionState(telegramUser, formatDate);
    return state.code === 'active' || state.code === 'grace';
  }

  async approveRequestWithNewClient({
    requestId,
    adminTelegramUserId,
  }) {
    const request = await this.store.getPendingRequest(requestId);
    if (!request || request.status !== 'pending') {
      return null;
    }

    const clientName = this.buildClientNameFromRequest(request);
    const client = await this.wireGuard.createClient({
      name: clientName,
      expiredDate: null,
    });
    let user;
    try {
      user = await this.store.approveRequest({
        requestId,
        clientId: client.id,
        adminTelegramUserId,
      });
    } catch (err) {
      await this.wireGuard.deleteClient({ clientId: client.id }).catch(() => {});
      throw err;
    }

    return {
      user,
      client,
      request,
    };
  }

  async approveRequestWithExistingClient({
    requestId,
    clientId,
    adminTelegramUserId,
  }) {
    const request = await this.store.getPendingRequest(requestId);
    if (!request || request.status !== 'pending') {
      return null;
    }

    const client = await this.wireGuard.getClient({ clientId }).catch(() => null);
    if (!client) {
      return {
        request,
        client: null,
        user: null,
      };
    }

    const user = await this.store.approveRequest({
      requestId,
      clientId,
      adminTelegramUserId,
    });

    return {
      user,
      client,
      request,
    };
  }

  async approveSubscriptionRequest({
    requestId,
    adminTelegramUserId,
  }) {
    const user = await this.store.approveSubscriptionRequest({
      requestId,
      adminTelegramUserId,
      durationDays: this.subscriptionDurationDays,
      graceDays: this.subscriptionGraceDays,
    });

    await this.setLinkedClientsEnabled(user.telegramUserId, true);
    return user;
  }

  async revokeSubscription({
    telegramUserId,
    adminTelegramUserId,
  }) {
    const user = await this.store.revokeSubscription(telegramUserId, adminTelegramUserId);
    await this.setLinkedClientsEnabled(telegramUserId, false);
    return user;
  }

  async setLinkedClientsEnabled(telegramUserId, enabled) {
    const clientIds = await this.store.listLinkedClientIds(telegramUserId);

    for (const clientId of clientIds) {
      try {
        if (enabled) {
          await this.wireGuard.enableClient({ clientId });
        } else {
          await this.wireGuard.disableClient({ clientId });
        }
      } catch (err) {
        debug(`Failed to toggle client ${clientId} for telegram user ${telegramUserId}: ${err.message}`);
      }
    }
  }

  async runSubscriptionMaintenance({
    formatDate,
    onGraceReminder,
  }) {
    const now = Date.now();
    if (this.lastSubscriptionMaintenanceAt && (now - this.lastSubscriptionMaintenanceAt) < 60 * 1000) {
      return;
    }
    this.lastSubscriptionMaintenanceAt = now;

    const users = await this.store.listTelegramUsers();
    for (const user of users) {
      if (user.status !== 'approved') {
        continue;
      }

      const state = this.getSubscriptionState(user, formatDate);
      if (state.code === 'grace') {
        const lastReminderAt = user.lastSubscriptionReminderAt ? new Date(user.lastSubscriptionReminderAt).getTime() : 0;
        if (!lastReminderAt || (now - lastReminderAt) >= 24 * 60 * 60 * 1000) {
          if (typeof onGraceReminder === 'function') {
            await onGraceReminder(user);
          }
          await this.store.markSubscriptionReminderSent(user.telegramUserId).catch(() => {});
        }
        continue;
      }

      if (state.code === 'expired') {
        await this.setLinkedClientsEnabled(user.telegramUserId, false);
      }
    }
  }

};
