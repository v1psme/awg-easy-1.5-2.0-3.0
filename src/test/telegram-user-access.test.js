'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TelegramUserAccessService = require('../lib/telegram/TelegramUserAccessService');

test('getSubscriptionState returns expected states', () => {
  const service = new TelegramUserAccessService({
    wireGuard: {},
    store: {},
    subscriptionDurationDays: 30,
    subscriptionGraceDays: 7,
  });
  const formatDate = (value) => value;
  const now = Date.now();

  assert.equal(service.getSubscriptionState(null, formatDate).code, 'missing');
  assert.equal(service.getSubscriptionState({
    subscriptionExpiresAt: new Date(now + 60_000).toISOString(),
  }, formatDate).code, 'active');
  assert.equal(service.getSubscriptionState({
    subscriptionExpiresAt: new Date(now - 60_000).toISOString(),
    subscriptionGraceUntil: new Date(now + 60_000).toISOString(),
  }, formatDate).code, 'grace');
  assert.equal(service.getSubscriptionState({
    subscriptionExpiresAt: new Date(now - 120_000).toISOString(),
    subscriptionGraceUntil: new Date(now - 60_000).toISOString(),
  }, formatDate).code, 'expired');
});

test('approveRequestWithNewClient rolls back created client if store approve fails', async () => {
  const calls = [];
  const service = new TelegramUserAccessService({
    wireGuard: {
      async createClient() {
        calls.push('createClient');
        return { id: 'client-1', name: 'client-1' };
      },
      async deleteClient({ clientId }) {
        calls.push(`deleteClient:${clientId}`);
      },
    },
    store: {
      async getPendingRequest() {
        return {
          id: 'req-1',
          status: 'pending',
          telegramUserId: 'tg-1',
          username: 'alice',
        };
      },
      async approveRequest() {
        throw new Error('db-failed');
      },
    },
    subscriptionDurationDays: 30,
    subscriptionGraceDays: 7,
  });

  await assert.rejects(() => service.approveRequestWithNewClient({
    requestId: 'req-1',
    adminTelegramUserId: 'admin-1',
  }), /db-failed/);

  assert.deepEqual(calls, [
    'createClient',
    'deleteClient:client-1',
  ]);
});
