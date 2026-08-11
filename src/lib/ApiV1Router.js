'use strict';

const {
  createRouter,
  defineEventHandler,
  getRouterParam,
  readBody,
  setHeader,
  createError,
} = require('h3');

const crypto = require('node:crypto');

class ApiV1Router {
  constructor({ wireGuard, configStore, config }) {
    this.__wireGuard = wireGuard;
    this.__configStore = configStore;
    this.__config = config;
  }

  async __getApiKey() {
    const stored = await this.__configStore.getApiKey().catch(() => null);
    return typeof stored?.key === 'string' && stored.key ? stored.key : null;
  }

  __setCorsHeaders(event) {
    setHeader(event, 'Access-Control-Allow-Origin', 'https://rednetline.com');
    setHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    setHeader(event, 'Access-Control-Allow-Headers', 'Authorization, Content-Type');
    setHeader(event, 'Access-Control-Max-Age', '86400');
  }

  async __auth(event) {
    const authHeader = event.node.req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized — missing Bearer token' });
    }

    const providedKey = authHeader.slice(7);
    if (!providedKey) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized — empty token' });
    }

    const apiKey = await this.__getApiKey();
    if (!apiKey) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized — no API key configured' });
    }

    if (providedKey.length !== apiKey.length
        || !crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(apiKey))) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized — invalid token' });
    }
  }

  mount(app) {
    const router = createRouter();
    app.use(router);

    // CORS preflight
    router.options('/api/v1/**', defineEventHandler((event) => {
      this.__setCorsHeaders(event);
      return '';
    }));

    // GET /api/v1/server — server status
    router.get('/api/v1/server', defineEventHandler(async (event) => {
      this.__setCorsHeaders(event);
      await this.__auth(event);

      const clients = await this.__wireGuard.getClients();
      const enabledClients = clients.filter((c) => c.enabled);

      return {
        online: true,
        wgPort: Number(this.__config.WG_PORT) || 51820,
        host: this.__config.WG_HOST || '',
        clientCount: enabledClients.length,
        version: this.__config.RELEASE || '0.0.0',
      };
    }));

    // GET /api/v1/clients — list clients
    router.get('/api/v1/clients', defineEventHandler(async (event) => {
      this.__setCorsHeaders(event);
      await this.__auth(event);

      const clients = await this.__wireGuard.getClients();

      return {
        clients: clients.map((client) => ({
          id: client.id,
          name: client.name,
          enabled: client.enabled === true,
          download: client.transferRx || 0,
          upload: client.transferTx || 0,
          totalDownload: client.transferRx || 0,
          totalUpload: client.transferTx || 0,
          createdAt: client.createdAt instanceof Date
            ? client.createdAt.toISOString()
            : client.createdAt,
          expireAt: client.expiredAt instanceof Date
            ? client.expiredAt.toISOString()
            : client.expiredAt,
        })),
      };
    }));

    // POST /api/v1/clients — create client
    router.post('/api/v1/clients', defineEventHandler(async (event) => {
      this.__setCorsHeaders(event);
      await this.__auth(event);

      const body = await readBody(event);
      const name = typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : null;
      if (!name) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid name' });
      }

      const expireDays = parseInt(body.expireDays, 10);
      let expiredDate = null;
      if (Number.isFinite(expireDays) && expireDays > 0) {
        expiredDate = new Date(Date.now() + expireDays * 86400 * 1000);
      }

      const client = await this.__wireGuard.createClient({ name, expiredDate });
      const config = await this.__wireGuard.getClientConfiguration({ clientId: client.id });
      const qrSvg = await this.__wireGuard.getClientQRCodeSVG({ clientId: client.id });
      const qrCode = `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}`;

      return {
        id: client.id,
        name: client.name,
        config,
        qrCode,
      };
    }));

    // DELETE /api/v1/clients/:id — delete client
    router.delete('/api/v1/clients/:id', defineEventHandler(async (event) => {
      this.__setCorsHeaders(event);
      await this.__auth(event);

      const clientId = getRouterParam(event, 'id');
      if (!clientId) {
        throw createError({ statusCode: 400, statusMessage: 'Client ID required' });
      }

      await this.__wireGuard.deleteClient({ clientId });

      return { success: true };
    }));
  }
}

module.exports = ApiV1Router;
