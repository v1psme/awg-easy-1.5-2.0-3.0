'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const basicAuth = require('basic-auth');
const { createServer } = require('node:http');
const httpolyglot = require('httpolyglot');
const { stat, readFile } = require('node:fs/promises');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, sep } = require('node:path');

const expressSession = require('express-session');
const debug = require('debug')('Server');

const {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  fromNodeMiddleware,
  getQuery,
  getRouterParam,
  toNodeListener,
  readBody,
  sendRedirect,
  setHeader,
  serveStatic,
} = require('h3');

const WireGuard = require('../services/WireGuard');
const TelegramBot = require('../services/TelegramBot');
const ConfigStore = require('./ConfigStore');
const SqliteMigrator = require('./db/SqliteMigrator');

const {
  PORT,
  WEBUI_HOST,
  RELEASE,
  PASSWORD_HASH,
  PASSWORD,
  MAX_AGE,
  LANG,
  WG_PORT,
  WG_CONFIG_PORT,
  WG_MTU,
  WG_DEFAULT_ADDRESS,
  WG_ALLOWED_IPS,
  WG_PERSISTENT_KEEPALIVE,
  UI_TRAFFIC_STATS,
  UI_CHART_TYPE,
  WG_ENABLE_ONE_TIME_LINKS,
  UI_ENABLE_SORT_CLIENTS,
  WG_ENABLE_EXPIRES_TIME,
  TRAFFIC_HISTORY_ENABLED,
  TRAFFIC_SAMPLE_INTERVAL_SECONDS,
  TRAFFIC_RAW_RETENTION_HOURS,
  TRAFFIC_MINUTE_RETENTION_DAYS,
  TRAFFIC_HOUR_RETENTION_DAYS,
  ENABLE_PROMETHEUS_METRICS,
  PROMETHEUS_METRICS_PASSWORD,
  PROMETHEUS_METRICS_PASSWORD_HASH,
  DICEBEAR_TYPE,
  USE_GRAVATAR,
  SSL_ENABLED,
  SSL_CERT_PATH,
  SSL_KEY_PATH,
  WG_PATH,
  WEB_PATH,
  REDIRECT_ROOT,
  ADMIN_LOGIN,
  WG_BYPASS_GEOSITE,
} = require('../config');
const requiresPrometheusPassword = !!PROMETHEUS_METRICS_PASSWORD || !!PROMETHEUS_METRICS_PASSWORD_HASH;

const getHttpsRedirectUrl = ({ host, url }) => {
  const [hostname] = (host || '').split(':');
  const targetHost = hostname || 'localhost';
  const targetPort = String(PORT) === '443' ? '' : `:${PORT}`;

  return `https://${targetHost}${targetPort}${url || '/'}`;
};

const toBooleanSetting = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }

  return fallback;
};

const toIntegerSetting = (value, fallback, min = null) => {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  if (min === null) {
    return normalized;
  }

  return Math.max(min, normalized);
};

const isValidPort = (value) => {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
};

const isValidWgDefaultAddress = (value) => {
  return typeof value === 'string'
    && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.x$/.test(value.trim());
};

const normalizeRuntimeSettingsPayload = (runtime, fallback) => {
  const normalized = {
    // Locked to env — changes only via .env file
    wgPort: String(WG_PORT).trim(),
    wgConfigPort: String(runtime.wgConfigPort || fallback.wgConfigPort || WG_CONFIG_PORT).trim(),
    wgMtu: String(WG_MTU || '').trim(),
    wgDefaultAddress: String(WG_DEFAULT_ADDRESS).trim(),
    wgAllowedIps: String(runtime.wgAllowedIps || fallback.wgAllowedIps || WG_ALLOWED_IPS).trim(),
    wgPersistentKeepalive: String(runtime.wgPersistentKeepalive || fallback.wgPersistentKeepalive || WG_PERSISTENT_KEEPALIVE).trim(),
    uiTrafficStats: toBooleanSetting(runtime.uiTrafficStats, fallback.uiTrafficStats),
    uiChartType: toIntegerSetting(runtime.uiChartType, fallback.uiChartType, 0),
    enableOneTimeLinks: toBooleanSetting(runtime.enableOneTimeLinks, fallback.enableOneTimeLinks),
    enableSortClients: toBooleanSetting(runtime.enableSortClients, fallback.enableSortClients),
    enableExpireTime: toBooleanSetting(runtime.enableExpireTime, fallback.enableExpireTime),
    timezone: typeof runtime.timezone === 'string' ? runtime.timezone.trim() : '',
    avatarDicebearType: typeof runtime.avatarDicebearType === 'string'
      ? runtime.avatarDicebearType.trim()
      : fallback.avatarDicebearType,
    avatarUseGravatar: toBooleanSetting(runtime.avatarUseGravatar, fallback.avatarUseGravatar),
    trafficHistoryEnabled: toBooleanSetting(runtime.trafficHistoryEnabled, fallback.trafficHistoryEnabled),
    trafficSampleIntervalSeconds: toIntegerSetting(runtime.trafficSampleIntervalSeconds, fallback.trafficSampleIntervalSeconds, 1),
    trafficRawRetentionHours: toIntegerSetting(runtime.trafficRawRetentionHours, fallback.trafficRawRetentionHours, 1),
    trafficMinuteRetentionDays: toIntegerSetting(runtime.trafficMinuteRetentionDays, fallback.trafficMinuteRetentionDays, 1),
    trafficHourRetentionDays: toIntegerSetting(runtime.trafficHourRetentionDays, fallback.trafficHourRetentionDays, 1),
  };

  if (!isValidPort(normalized.wgPort)) {
    throw createError({ statusCode: 400, statusMessage: 'WG_PORT must be a valid TCP/UDP port.' });
  }

  if (!isValidPort(normalized.wgConfigPort)) {
    throw createError({ statusCode: 400, statusMessage: 'WG_CONFIG_PORT must be a valid port.' });
  }

  if (normalized.wgMtu) {
    const mtu = Number.parseInt(normalized.wgMtu, 10);
    if (!Number.isInteger(mtu) || mtu < 576 || mtu > 9200) {
      throw createError({ statusCode: 400, statusMessage: 'WG_MTU must be empty or between 576 and 9200.' });
    }
  }

  if (!isValidWgDefaultAddress(normalized.wgDefaultAddress)) {
    throw createError({ statusCode: 400, statusMessage: 'WG_DEFAULT_ADDRESS must look like 10.8.0.x.' });
  }

  if (!normalized.wgAllowedIps) {
    throw createError({ statusCode: 400, statusMessage: 'WG_ALLOWED_IPS must not be empty.' });
  }

  const keepalive = Number.parseInt(normalized.wgPersistentKeepalive, 10);
  if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 65535) {
    throw createError({ statusCode: 400, statusMessage: 'WG_PERSISTENT_KEEPALIVE must be between 0 and 65535.' });
  }

  if (normalized.uiChartType < 0 || normalized.uiChartType > 3) {
    throw createError({ statusCode: 400, statusMessage: 'UI_CHART_TYPE must be between 0 and 3.' });
  }

  return normalized;
};

/**
 * Checks if `password` matches the PASSWORD_HASH.
 *
 * If environment variable is not set, the password is always invalid.
 *
 * @param {string} password String to test
 * @returns {boolean} true if matching environment, otherwise false
 */
const isPasswordValid = (password, hash, plainPassword) => {
  if (typeof password !== 'string') {
    return false;
  }

  if (typeof plainPassword === 'string' && plainPassword.length > 0) {
    const inputBuffer = Buffer.from(password);
    const secretBuffer = Buffer.from(plainPassword);
    if (inputBuffer.length === secretBuffer.length && crypto.timingSafeEqual(inputBuffer, secretBuffer)) {
      return true;
    }
  }

  if (hash) {
    try {
      return bcrypt.compareSync(password, hash);
    } catch (err) {
      debug(`Failed to compare password hash: ${err.message}`);
      return false;
    }
  }

  return false;
};

const getClientIp = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0];
  }

  return req.socket?.remoteAddress || 'unknown';
};

const cronJobEveryMinute = async () => {
  await WireGuard.cronJobEveryMinute();
  setTimeout(cronJobEveryMinute, 60 * 1000);
};

module.exports = class Server {

  __loadOrCreateSessionSecretSync() {
    const dbPath = resolve(WG_PATH, 'wg-easy.db');
    const fallbackSecret = crypto.createHash('sha256')
      .update(`${WG_PATH}:${PASSWORD_HASH || PASSWORD || 'amneziawg'}`)
      .digest('hex');

    try {
      const migrator = new SqliteMigrator({
        dbPath,
        basePath: WG_PATH,
      });
      migrator.migrateSync();

      const stdout = execFileSync('sqlite3', [
        '-json',
        dbPath,
        `
        SELECT value FROM app_state WHERE key = 'session_secret' LIMIT 1;
        `,
      ], {
        encoding: 'utf8',
      });

      const rows = stdout ? JSON.parse(stdout) : [];
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0].value === 'string' && rows[0].value) {
        return rows[0].value;
      }

      const secret = crypto.randomBytes(64).toString('hex');
      execFileSync('sqlite3', [
        dbPath,
        `
        INSERT INTO app_state (key, value, updated_at)
        VALUES ('session_secret', '${secret}', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP;
        `,
      ], {
        encoding: 'utf8',
      });

      return secret;
    } catch (err) {
      debug(`Failed to persist session secret, using deterministic fallback: ${err.message}`);
      return fallbackSecret;
    }
  }

  __checkLoginRateLimit(ip) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    const windowMs = 10 * 60 * 1000;
    const maxAttempts = 10;
    const blockMs = 15 * 60 * 1000;
    const current = this.loginAttempts.get(key);

    if (current && current.blockedUntil && current.blockedUntil > now) {
      throw createError({
        status: 429,
        message: 'Too many login attempts. Try again later.',
      });
    }

    if (!current) {
      return;
    }

    const attempts = current.attempts.filter((at) => (now - at) < windowMs);
    current.attempts = attempts;
    current.blockedUntil = 0;
    this.loginAttempts.set(key, current);

    if (attempts.length >= maxAttempts) {
      current.blockedUntil = now + blockMs;
      this.loginAttempts.set(key, current);
      throw createError({
        status: 429,
        message: 'Too many login attempts. Try again later.',
      });
    }
  }

  __recordLoginAttempt(ip, successful) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    const current = this.loginAttempts.get(key) || {
      attempts: [],
      blockedUntil: 0,
    };

    if (successful) {
      this.loginAttempts.delete(key);
      return;
    }

    current.attempts = current.attempts.filter((at) => (now - at) < 10 * 60 * 1000);
    current.attempts.push(now);
    this.loginAttempts.set(key, current);
  }

  constructor() {
    const app = createApp();
    this.app = app;
    this.eventSubscribers = new Set();
    this.loginAttempts = new Map();
    this.configStore = new ConfigStore({
      basePath: WG_PATH,
    });
    this.sessionSecret = this.__loadOrCreateSessionSecretSync();

    // Normalize WEB_PATH prefix
    const webPath = WEB_PATH
      ? ('/' + WEB_PATH.replace(/^\/+|\/+$/g, '')).replace(/\/+$/, '') || '/'
      : '';

    app.use(fromNodeMiddleware(expressSession({
      name: 'amneziawg.sid',
      secret: this.sessionSecret,
      resave: false,
      saveUninitialized: false,
      proxy: SSL_ENABLED,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: SSL_ENABLED,
        path: webPath || '/',
      },
    })));

    app.use(fromNodeMiddleware((req, res, next) => {
      const startedAt = Date.now();
      res.on('finish', () => {
        if (res.statusCode !== 403 && res.statusCode !== 404) {
          return;
        }
        const logUrl = req.originalUrl || req.url;
        if (!logUrl.startsWith('/api/') && !logUrl.startsWith('/cnf/')) {
          return;
        }

        const clientIp = getClientIp(req);
        const userAgent = req.headers['user-agent'] || '-';
        // eslint-disable-next-line no-console
        console.warn(`[HTTP ${res.statusCode}] ${req.method} ${logUrl} ip=${clientIp} ua="${userAgent}" duration_ms=${Date.now() - startedAt}`);
      });
      next();
    }));

    const router = createRouter();
    app.use(router);

    const assertFeatureAuth = async (event) => {
      const auth = await this.__getEffectiveAuthSettings();
      if (!auth.requiresPassword) {
        return;
      }

      if (event.node.req.session && event.node.req.session.authenticated) {
        return;
      }

      throw createError({
        status: 401,
        message: 'Not Logged In',
      });
    };

    router
      .get('/api/release', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(() => {
          setHeader(event, 'Content-Type', 'application/json');
          return RELEASE;
        });
      }))

      .get('/api/service-info', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(() => {
          setHeader(event, 'Content-Type', 'application/json');
          return {
            serviceName: require('../config').SERVICE_NAME,
            awgVersion: require('../config').AMNEZIA_VERSION,
          };
        });
      }))

      .get('/api/lang', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(() => {
          setHeader(event, 'Content-Type', 'application/json');
          return `"${LANG}"`;
        });
      }))

      .get('/api/remember-me', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(() => {
          setHeader(event, 'Content-Type', 'application/json');
          return MAX_AGE > 0;
        });
      }))

      .get('/api/ui-traffic-stats', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(async () => {
        setHeader(event, 'Content-Type', 'application/json');
        const appSettings = await this.__getEffectiveAppSettings();
        return appSettings.uiTrafficStats;
        });
      }))

      .get('/api/ui-chart-type', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(async () => {
        setHeader(event, 'Content-Type', 'application/json');
        const appSettings = await this.__getEffectiveAppSettings();
        return `${appSettings.uiChartType}`;
        });
      }))

      .get('/api/wg-enable-one-time-links', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(async () => {
        setHeader(event, 'Content-Type', 'application/json');
        const appSettings = await this.__getEffectiveAppSettings();
        return appSettings.enableOneTimeLinks;
        });
      }))

      .get('/api/ui-sort-clients', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(async () => {
        setHeader(event, 'Content-Type', 'application/json');
        const appSettings = await this.__getEffectiveAppSettings();
        return appSettings.enableSortClients;
        });
      }))

      .get('/api/wg-enable-expire-time', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(async () => {
        setHeader(event, 'Content-Type', 'application/json');
        const appSettings = await this.__getEffectiveAppSettings();
        return appSettings.enableExpireTime;
        });
      }))

      .get('/api/ui-avatar-settings', defineEventHandler((event) => {
        return Promise.resolve(assertFeatureAuth(event)).then(async () => {
          const appSettings = await this.__getEffectiveAppSettings();
          setHeader(event, 'Content-Type', 'application/json');
          return {
            dicebear: appSettings.avatarDicebearType,
            gravatar: appSettings.avatarUseGravatar,
          };
        });
      }))

      // Authentication
      .get('/api/setup-state', defineEventHandler(async (event) => {
        const sessionState = await this.__getSessionState(event);
        return {
          needsSetup: sessionState.needsSetup,
          configured: !sessionState.needsSetup,
          hasPassword: sessionState.requiresPassword,
          adminLoginRequired: !!ADMIN_LOGIN,
          serviceName: require('../config').SERVICE_NAME,
          awgVersion: (v => v === '2' ? '2.0' : v === '3' ? '3.0' : v)(require('../config').AMNEZIA_VERSION),
          wgHostConfigured: sessionState.wgHostConfigured,
          defaults: {
            defaultDns: sessionState.appSettings.defaultDns,
            wgPort: sessionState.appSettings.wgPort,
            wgConfigPort: sessionState.appSettings.wgConfigPort,
            wgMtu: sessionState.appSettings.wgMtu,
            wgDefaultAddress: sessionState.appSettings.wgDefaultAddress,
            wgAllowedIps: sessionState.appSettings.wgAllowedIps,
            wgPersistentKeepalive: sessionState.appSettings.wgPersistentKeepalive,
            uiTrafficStats: sessionState.appSettings.uiTrafficStats,
            uiChartType: sessionState.appSettings.uiChartType,
            enableOneTimeLinks: sessionState.appSettings.enableOneTimeLinks,
            enableSortClients: sessionState.appSettings.enableSortClients,
            enableExpireTime: sessionState.appSettings.enableExpireTime,
            avatarDicebearType: sessionState.appSettings.avatarDicebearType,
            avatarUseGravatar: sessionState.appSettings.avatarUseGravatar,
            trafficHistoryEnabled: sessionState.appSettings.trafficHistoryEnabled,
            trafficSampleIntervalSeconds: sessionState.appSettings.trafficSampleIntervalSeconds,
            trafficRawRetentionHours: sessionState.appSettings.trafficRawRetentionHours,
            trafficMinuteRetentionDays: sessionState.appSettings.trafficMinuteRetentionDays,
            trafficHourRetentionDays: sessionState.appSettings.trafficHourRetentionDays,
          },
        };
      }))
      .post('/api/setup', defineEventHandler(async (event) => {
        const auth = await this.__getEffectiveAuthSettings();
        const appSettings = await this.__getEffectiveAppSettings();
        const needsSetup = !auth.requiresPassword || !appSettings.wgHostConfigured;

        if (!needsSetup) {
          throw createError({
            status: 400,
            message: 'Initial setup has already been completed.',
          });
        }

        const body = await readBody(event);
        const password = typeof body.password === 'string' ? body.password : '';
        const wgHost = typeof body.wgHost === 'string' ? body.wgHost.trim() : '';
        const defaultDns = typeof body.defaultDns === 'string' ? body.defaultDns.trim() : '';
        const runtime = body.runtime && typeof body.runtime === 'object' ? body.runtime : {};
        const normalizedRuntime = normalizeRuntimeSettingsPayload(runtime, appSettings);

        if (password.length < 8) {
          throw createError({
            status: 400,
            message: 'Password must be at least 8 characters long.',
          });
        }

        if (!wgHost) {
          throw createError({
            status: 400,
            message: 'WG host is required.',
          });
        }

        const passwordHash = bcrypt.hashSync(password, 12);
        await this.configStore.setAuthSettings({
          passwordHash,
        });
        await this.configStore.setAppSettings({
          wgHost,
          defaultDns: defaultDns || appSettings.defaultDns || '',
          ...normalizedRuntime,
        });

        return {
          success: true,
        };
      }))
      .get('/api/session', defineEventHandler(async (event) => {
        const auth = await this.__getEffectiveAuthSettings();
        const authenticated = auth.requiresPassword
          ? !!(event.node.req.session && event.node.req.session.authenticated)
          : true;
        return this.__getSessionState(event, authenticated);
      }))
      .get('/api/events', defineEventHandler(async (event) => {
        const auth = await this.__getEffectiveAuthSettings();
        const authenticated = auth.requiresPassword
          ? !!(event.node.req.session && event.node.req.session.authenticated)
          : true;

        if (!authenticated) {
          throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
        }

        const res = event.node.res;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.write(': connected\n\n');

        const subscriber = { res };
        this.eventSubscribers.add(subscriber);

        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {}
        }, 25000);

        const cleanup = () => {
          clearInterval(heartbeat);
          this.eventSubscribers.delete(subscriber);
        };

        event.node.req.on('close', cleanup);
        event.node.req.on('error', cleanup);

        return new Promise(() => {});
      }))
      .get('/cnf/:clientOneTimeLink', defineEventHandler(async (event) => {
        const appSettings = await this.__getEffectiveAppSettings();
        if (!appSettings.enableOneTimeLinks) {
          throw createError({
            status: 404,
            message: 'Invalid state',
          });
        }
        const clientOneTimeLink = getRouterParam(event, 'clientOneTimeLink');
        const clients = await WireGuard.getClients();
        const client = clients.find((client) => client.oneTimeLink === clientOneTimeLink);
        if (!client || !client.oneTimeLinkExpiresAt || new Date() > new Date(client.oneTimeLinkExpiresAt)) {
          throw createError({
            status: 404,
            message: 'Link expired or not found',
          });
        }
        const clientId = client.id;
        const config = await WireGuard.getClientConfiguration({ clientId });
        await WireGuard.eraseOneTimeLink({ clientId });
        const configName = client.name
          .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
          .replace(/(-{2,}|-$)/g, '-')
          .replace(/-$/, '')
          .substring(0, 32);
        setHeader(event, 'Content-Disposition', `attachment; filename="${configName || clientId}.conf"`);
        setHeader(event, 'Content-Type', 'text/plain');
        return config;
      }))
      .post('/api/session', defineEventHandler(async (event) => {
        const auth = await this.__getEffectiveAuthSettings();
        const { login, password, remember } = await readBody(event);
        const clientIp = getClientIp(event.node.req);

        this.__checkLoginRateLimit(clientIp);

        if (!auth.requiresPassword) {
          // if no password is required, the API should never be called.
          // Do not automatically authenticate the user.
          throw createError({
            statusCode: 401,
            statusMessage: 'Invalid state',
          });
        }

        if (ADMIN_LOGIN) {
          if (typeof login !== 'string' || !login.trim()) {
            this.__recordLoginAttempt(clientIp, false);
            throw createError({
              statusCode: 401,
              statusMessage: 'Login is required',
            });
          }
          if (login.trim() !== ADMIN_LOGIN) {
            this.__recordLoginAttempt(clientIp, false);
            throw createError({
              statusCode: 401,
              statusMessage: 'Invalid credentials',
            });
          }
        }

        if (!isPasswordValid(password, auth.passwordHash, auth.password)) {
          this.__recordLoginAttempt(clientIp, false);
          throw createError({
            statusCode: 401,
            statusMessage: 'Incorrect Password',
          });
        }

        this.__recordLoginAttempt(clientIp, true);

        await new Promise((resolve, reject) => {
          event.node.req.session.regenerate((err) => {
            if (err) {
              reject(err);
              return;
            }

            if (MAX_AGE && remember) {
              event.node.req.session.cookie.maxAge = MAX_AGE;
            }
            event.node.req.session.authenticated = true;
            event.node.req.session.save((saveErr) => {
              if (saveErr) {
                reject(saveErr);
                return;
              }

              debug(`New Session: ${event.node.req.session.id}`);
              resolve();
            });
          });
        });

        return { success: true };
      }))
      .get('/api/settings', defineEventHandler(async () => {
        const auth = await this.__getEffectiveAuthSettings();
        const appSettings = await this.__getEffectiveAppSettings();
        const telegramSettings = await this.__getEffectiveTelegramSettings();

        return {
          wgHost: appSettings.wgHost,
          defaultDns: appSettings.defaultDns,
          runtime: {
            wgPort: appSettings.wgPort,
            wgConfigPort: appSettings.wgConfigPort,
            wgMtu: appSettings.wgMtu,
            wgDefaultAddress: appSettings.wgDefaultAddress,
            wgAllowedIps: appSettings.wgAllowedIps,
            wgPersistentKeepalive: appSettings.wgPersistentKeepalive,
            uiTrafficStats: appSettings.uiTrafficStats,
            uiChartType: appSettings.uiChartType,
            enableOneTimeLinks: appSettings.enableOneTimeLinks,
            enableSortClients: appSettings.enableSortClients,
            enableExpireTime: appSettings.enableExpireTime,
            timezone: appSettings.timezone || '',
            avatarDicebearType: appSettings.avatarDicebearType,
            avatarUseGravatar: appSettings.avatarUseGravatar,
            trafficHistoryEnabled: appSettings.trafficHistoryEnabled,
            trafficSampleIntervalSeconds: appSettings.trafficSampleIntervalSeconds,
            trafficRawRetentionHours: appSettings.trafficRawRetentionHours,
            trafficMinuteRetentionDays: appSettings.trafficMinuteRetentionDays,
            trafficHourRetentionDays: appSettings.trafficHourRetentionDays,
          },
          hasPassword: auth.requiresPassword,
          telegram: {
            enabled: telegramSettings.enabled,
            token: telegramSettings.token,
            adminIds: telegramSettings.adminIds,
            pollTimeoutSeconds: telegramSettings.pollTimeoutSeconds,
            subscriptionPhoneNumber: telegramSettings.subscriptionPhoneNumber,
            subscriptionRecipientName: telegramSettings.subscriptionRecipientName,
            subscriptionBankName: telegramSettings.subscriptionBankName,
            subscriptionPaymentNote: telegramSettings.subscriptionPaymentNote,
          },
        };
      }))
      .put('/api/settings', defineEventHandler(async (event) => {
        const body = await readBody(event);
        const wgHost = typeof body.wgHost === 'string' ? body.wgHost.trim() : '';
        const defaultDns = typeof body.defaultDns === 'string' ? body.defaultDns.trim() : '';
        const runtime = body.runtime && typeof body.runtime === 'object' ? body.runtime : {};
        const appSettings = await this.__getEffectiveAppSettings();
        const normalizedRuntime = normalizeRuntimeSettingsPayload(runtime, appSettings);
        const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
        const telegramEnabled = body.telegram && body.telegram.enabled === true;
        const telegramToken = typeof body.telegram?.token === 'string' ? body.telegram.token.trim() : '';
        const telegramAdminIds = typeof body.telegram?.adminIds === 'string' ? body.telegram.adminIds.trim() : '';
        const telegramPollTimeoutSeconds = Math.max(1, parseInt(body.telegram?.pollTimeoutSeconds, 10) || 25);
        const telegramSubscriptionPhoneNumber = typeof body.telegram?.subscriptionPhoneNumber === 'string'
          ? body.telegram.subscriptionPhoneNumber.trim()
          : '';
        const telegramSubscriptionRecipientName = typeof body.telegram?.subscriptionRecipientName === 'string'
          ? body.telegram.subscriptionRecipientName.trim()
          : '';
        const telegramSubscriptionBankName = typeof body.telegram?.subscriptionBankName === 'string'
          ? body.telegram.subscriptionBankName.trim()
          : '';
        const telegramSubscriptionPaymentNote = typeof body.telegram?.subscriptionPaymentNote === 'string'
          ? body.telegram.subscriptionPaymentNote.trim()
          : '';
        if (!wgHost) {
          throw createError({
            status: 400,
            message: 'WG host is required.',
          });
        }

        if (newPassword && newPassword.length < 8) {
          throw createError({
            status: 400,
            message: 'Password must be at least 8 characters long.',
          });
        }

        await this.configStore.setAppSettings({
          wgHost,
          defaultDns: defaultDns || appSettings.defaultDns || '',
          ...normalizedRuntime,
        });

        if (newPassword) {
          await this.configStore.setAuthSettings({
            passwordHash: bcrypt.hashSync(newPassword, 12),
          });
        }

        await this.configStore.setTelegramSettings({
          enabled: telegramEnabled,
          token: telegramToken,
          adminIds: telegramAdminIds,
          pollTimeoutSeconds: telegramPollTimeoutSeconds,
          subscriptionPhoneNumber: telegramSubscriptionPhoneNumber,
          subscriptionRecipientName: telegramSubscriptionRecipientName,
          subscriptionBankName: telegramSubscriptionBankName,
          subscriptionPaymentNote: telegramSubscriptionPaymentNote,
        });

        await WireGuard.applyRuntimeSettings();
        await TelegramBot.reload();
        this.broadcastUiEvent('state-updated');

        return { success: true };
      }))
      .get('/api/api-key', defineEventHandler(async (event) => {
        if (!event.node.req.session?.authenticated) {
          const err = new Error('Session required');
          err.statusCode = 401;
          throw err;
        }
        const key = await this.__getApiKey();
        return { apiKey: key || null };
      }))
      .post('/api/api-key/regen', defineEventHandler(async (event) => {
        if (!event.node.req.session?.authenticated) {
          const err = new Error('Session required');
          err.statusCode = 401;
          throw err;
        }
        const newKey = await this.__generateApiKey();
        return { apiKey: newKey };
      }));

    // WireGuard
    app.use(
      fromNodeMiddleware((req, res, next) => {
        Promise.resolve().then(async () => {
          if (!req.url.startsWith('/api/')) {
            return next();
          }

          if (req.url === '/api/session' || req.url === '/api/setup' || req.url === '/api/setup-state') {
            return next();
          }

          const auth = await this.__getEffectiveAuthSettings();
          const appSettings = await this.__getEffectiveAppSettings();
          const needsSetup = !auth.requiresPassword || !appSettings.wgHostConfigured;

          if (needsSetup) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'Initial setup required',
              needsSetup: true,
            }));
            return;
          }

          if (!auth.requiresPassword) {
            return next();
          }

          if (req.session && req.session.authenticated) {
            return next();
          }

          if (req.headers['authorization']) {
            const authHeader = req.headers['authorization'];
            if (authHeader.startsWith('Bearer ')) {
              const apiKey = await this.__getApiKey();
              const providedKey = authHeader.slice(7);
              if (apiKey && providedKey.length === apiKey.length
                && crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(apiKey))) {
                return next();
              }
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Invalid API Key' }));
              return;
            }
            if (isPasswordValid(authHeader, auth.passwordHash, auth.password)) {
              return next();
            }
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Incorrect Password' }));
            return;
          }

          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Not Logged In' }));
        }).catch(next);
      }),
    );

    const router2 = createRouter();
    app.use(router2);

    router2
      .delete('/api/session', defineEventHandler((event) => {
        const sessionId = event.node.req.session.id;

        event.node.req.session.destroy();

        debug(`Deleted Session: ${sessionId}`);
        return { success: true };
      }))
      .get('/api/wireguard/client', defineEventHandler(async () => {
        return WireGuard.getClients();
      }))
      .get('/api/wireguard/uplink', defineEventHandler(async () => {
        return WireGuard.getUplinkSettings();
      }))
      .get('/api/wireguard/uplinks', defineEventHandler(async () => {
        return WireGuard.getUplinkSettingsList();
      }))
      .get('/api/wireguard/uplink-configs', defineEventHandler(async () => {
        return WireGuard.getAvailableUplinkConfigs();
      }))
      .post('/api/wireguard/uplink-configs', defineEventHandler(async (event) => {
        const { filename, content } = await readBody(event);
        const result = await WireGuard.saveUplinkConfigFile({
          filename,
          content,
        });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .post('/api/wireguard/uplink-domains-file', defineEventHandler(async (event) => {
        const { filename, domains } = await readBody(event);
        await WireGuard.saveUplinkDomainsFile({ filename, domains });
        return { success: true, filename };
      }))
      .get('/api/wireguard/dns-routing', defineEventHandler(async () => {
        return WireGuard.getDnsRoutingSettings();
      }))
      .get('/api/wireguard/dns-logs', defineEventHandler(async (event) => {
        const { limit } = getQuery(event);
        return WireGuard.getDnsQueryLogs({ limit });
      }))
      .get('/api/wireguard/client-isolation', defineEventHandler(async () => {
        return WireGuard.getClientIsolationSettings();
      }))
      .get('/api/wireguard/client/:clientId/qrcode.svg', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const svg = await WireGuard.getClientQRCodeSVG({ clientId });
        setHeader(event, 'Content-Type', 'image/svg+xml');
        return svg;
      }))
      .get('/api/wireguard/client/:clientId/vpn-key', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const config = await WireGuard.getClientVpnKey({ clientId });
        setHeader(event, 'Content-Type', 'text/plain');
        return config;
      }))
      .get('/api/wireguard/client/:clientId/vpn-config', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const client = await WireGuard.getClient({ clientId });
        const config = await WireGuard.getClientVpnConfig({ clientId });
        const configName = client.name
          .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '') || clientId;
        setHeader(event, 'Content-Disposition', `attachment; filename="${configName || clientId}.vpn"`);
        setHeader(event, 'Content-Type', 'application/json');
        return JSON.stringify(config, null, 2);
      }))
      .get('/api/wireguard/client/:clientId/configuration', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const client = await WireGuard.getClient({ clientId });
        const config = await WireGuard.getClientConfiguration({ clientId });
        const configName = client.name
          .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
          .replace(/(-{2,}|-$)/g, '-')
          .replace(/-$/, '')
          .substring(0, 32);
        setHeader(event, 'Content-Disposition', `attachment; filename="${configName || clientId}.conf"`);
        setHeader(event, 'Content-Type', 'text/plain');
        return config;
      }))
      .post('/api/wireguard/client', defineEventHandler(async (event) => {
        const { name, expiredDate } = await readBody(event);
        await WireGuard.createClient({ name, expiredDate });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .delete('/api/wireguard/client/:clientId', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        await WireGuard.deleteClient({ clientId });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .post('/api/wireguard/client/:clientId/enable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.enableClient({ clientId });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .post('/api/wireguard/client/:clientId/generateOneTimeLink', defineEventHandler(async (event) => {
        const appSettings = await this.__getEffectiveAppSettings();
        if (!appSettings.enableOneTimeLinks) {
          throw createError({
            status: 404,
            message: 'Invalid state',
          });
        }
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.generateOneTimeLink({ clientId });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .post('/api/wireguard/client-uplink-assignment', defineEventHandler(async (event) => {
        const { clientId, uplinkId } = await readBody(event);
        const result = await WireGuard.setClientUplinkAssignment({ clientId, uplinkId });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .get('/api/wireguard/traffic', defineEventHandler(async () => {
        return WireGuard.getTrafficOverview();
      }))
      .get('/api/wireguard/client/:clientId/traffic', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const { period } = getQuery(event);
        return WireGuard.getClientTrafficHistory({
          clientId,
          period: typeof period === 'string' ? period : 'day',
        });
      }))
      .post('/api/wireguard/client/:clientId/disable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.disableClient({ clientId });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/name', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { name } = await readBody(event);
        await WireGuard.updateClientName({ clientId, name });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/address', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { address } = await readBody(event);
        await WireGuard.updateClientAddress({ clientId, address });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/acl-groups', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { aclGroups } = await readBody(event);
        await WireGuard.updateClientAclGroups({ clientId, aclGroups });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/expireDate', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { expireDate } = await readBody(event);
        await WireGuard.updateClientExpireDate({ clientId, expireDate });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/email', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { email } = await readBody(event);
        await WireGuard.updateClientEmail({ clientId, email });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/telegram-id', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { telegramId } = await readBody(event);
        await WireGuard.updateClientTelegramId({ clientId, telegramId });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/groups', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { groups } = await readBody(event);
        await WireGuard.updateClientGroups({ clientId, groups });
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }))
      .put('/api/wireguard/client-isolation', defineEventHandler(async (event) => {
        const { enabled, rules } = await readBody(event);
        const result = await WireGuard.updateClientIsolationSettings({ enabled, rules });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .get('/api/wireguard/uplink-protected-cidrs', defineEventHandler(async () => {
        return WireGuard.getUplinkProtectedCidrs();
      }))
      .put('/api/wireguard/uplink-protected-cidrs', defineEventHandler(async (event) => {
        const { cidrs } = await readBody(event);
        const result = await WireGuard.updateUplinkProtectedCidrs({ cidrs });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .post('/api/wireguard/uplink/test', defineEventHandler(async () => {
        return WireGuard.testUplinkConnection();
      }))
      .post('/api/wireguard/uplink/:uplinkId/test', defineEventHandler(async (event) => {
        const uplinkId = getRouterParam(event, 'uplinkId');
        return WireGuard.testUplinkConnection({ uplinkId });
      }))
      .put('/api/wireguard/uplink', defineEventHandler(async (event) => {
        const {
          id,
          name,
          enabled,
          configPath,
          interfaceName,
          table,
          sourceRules,
          destinationDomains,
          destinationIps,
          geoSiteSync,
          geoIpSync,
        } = await readBody(event);

        const result = await WireGuard.updateUplinkSettings({
          id,
          name,
          enabled,
          configPath,
          interfaceName,
          table,
          sourceRules,
          destinationDomains,
          destinationIps,
          geoSiteSync,
          geoIpSync,
        });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .put('/api/wireguard/uplinks', defineEventHandler(async (event) => {
        const { uplinks } = await readBody(event);
        const result = await WireGuard.updateUplinkSettingsList({ uplinks });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .get('/api/wireguard/uplink/geosite-status', defineEventHandler(async () => {
        return WireGuard.getGeoSiteStatus();
      }))
      .post('/api/wireguard/uplink/geosite-load', defineEventHandler(async (event) => {
        const { categoryName } = await readBody(event);
        const result = await WireGuard.loadGeoSiteDomains({ categoryName });
        await WireGuard.syncGeoSiteToUplinks();
        // Attach actual domains to each category (same pattern as GeoIP returns cidrs)
        for (const cat of result.categories) {
          cat.domains = WireGuard.__loadGeoSiteDomains(cat.category);
        }
        // NOTE: no broadcastUiEvent here — frontend merges domains locally.
        // Broadcasting would trigger SSE → refreshUplinkSettings() which overwrites the merge.
        return result;
      }))
      .post('/api/wireguard/uplink/geoip-load', defineEventHandler(async () => {
        return WireGuard.loadGeoIpCidrs();
      }))
      .get('/api/wireguard/routing-categories', defineEventHandler(async () => {
        return WireGuard.getRoutingCategories();
      }))
      .put('/api/wireguard/routing-categories', defineEventHandler(async (event) => {
        const { categories } = await readBody(event);
        const result = await WireGuard.updateRoutingCategories({ categories });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .get('/api/wireguard/client/:clientId/routing-categories', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        return WireGuard.getClientRoutingCategories(clientId);
      }))
      .put('/api/wireguard/client/:clientId/routing-categories/:categoryId', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const categoryId = getRouterParam(event, 'categoryId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { enabled } = await readBody(event);
        const result = await WireGuard.toggleClientRoutingCategory({
          clientId,
          categoryId,
          enabled: enabled === true,
        });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .put('/api/wireguard/dns-routing', defineEventHandler(async (event) => {
        const { enabled, resolveEnabled, upstreams } = await readBody(event);
        const result = await WireGuard.updateDnsRoutingSettings({ enabled, resolveEnabled, upstreams });
        this.broadcastUiEvent('state-updated');
        return result;
      }))
      .get('/api/wireguard/dns-routing/resolve-status', defineEventHandler(async () => {
        return WireGuard.getDnsResolveStatus();
      }))
      .post('/api/wireguard/dns-routing/resolve', defineEventHandler(async () => {
        const result = await WireGuard.startDnsResolve();
        this.broadcastUiEvent('state-updated');
        return result;
      }));

    const safePathJoin = (base, target) => {
      // Manage web root (edge case)
      if (target === '/') {
        return `${base}${sep}`;
      }

      // Prepend './' to prevent absolute paths
      const targetPath = `.${sep}${target}`;

      // Resolve the absolute path
      const resolvedPath = resolve(base, targetPath);

      // Check if resolvedPath is a subpath of base
      if (resolvedPath.startsWith(`${base}${sep}`)) {
        return resolvedPath;
      }

      throw createError({
        status: 400,
        message: 'Bad Request',
      });
    };

    // Check Prometheus credentials
    app.use(
      fromNodeMiddleware((req, res, next) => {
        if (!requiresPrometheusPassword || !req.url.startsWith('/metrics')) {
          return next();
        }
        const user = basicAuth(req);
        if (!user) {
          res.statusCode = 401;
          return { error: 'Not Logged In' };
        }
        if (user.pass) {
          if (isPasswordValid(user.pass, PROMETHEUS_METRICS_PASSWORD_HASH, PROMETHEUS_METRICS_PASSWORD)) {
            return next();
          }
          res.statusCode = 401;
          return { error: 'Incorrect Password' };
        }
        res.statusCode = 401;
        return { error: 'Not Logged In' };
      }),
    );

    // Prometheus Metrics API
    const routerPrometheusMetrics = createRouter();
    app.use(routerPrometheusMetrics);

    // Prometheus Routes
    routerPrometheusMetrics
      .get('/metrics', defineEventHandler(async (event) => {
        setHeader(event, 'Content-Type', 'text/plain');
        if (ENABLE_PROMETHEUS_METRICS === 'true') {
          return WireGuard.getMetrics();
        }
        return '';
      }))
      .get('/metrics/json', defineEventHandler(async (event) => {
        setHeader(event, 'Content-Type', 'application/json');
        if (ENABLE_PROMETHEUS_METRICS === 'true') {
          return WireGuard.getMetricsJSON();
        }
        return '';
      }));

    // backup_restore
    const router3 = createRouter();
    app.use(router3);

    router3
      .get('/api/wireguard/backup', defineEventHandler(async (event) => {
        const config = await WireGuard.backupConfiguration();
        setHeader(event, 'Content-Disposition', 'attachment; filename="wg0.json"');
        setHeader(event, 'Content-Type', 'text/json');
        return config;
      }))
      .put('/api/wireguard/restore', defineEventHandler(async (event) => {
        const { file } = await readBody(event);
        await WireGuard.restoreConfiguration(file);
        this.broadcastUiEvent('state-updated');
        return { success: true };
      }));

    // Static assets
    const publicDir = '/app/www';
    app.use(
      defineEventHandler(async (event) => {
        const requestedPath = (event.node.req.url || '/').split('?')[0];
        if (requestedPath === '/' || requestedPath === '/index.html') {
          const auth = await this.__getEffectiveAuthSettings();
          const appSettings = await this.__getEffectiveAppSettings();
          const needsSetup = !auth.requiresPassword || !appSettings.wgHostConfigured;
          const authenticated = auth.requiresPassword
            ? !!(event.node.req.session && event.node.req.session.authenticated)
            : true;
          const shellFile = authenticated ? 'index.html' : 'login.html';

          setHeader(event, 'Content-Type', 'text/html');
          return readFile(safePathJoin(publicDir, shellFile));
        }

        return serveStatic(event, {
          getContents: (id) => {
            return readFile(safePathJoin(publicDir, id));
          },
          getMeta: async (id) => {
            const filePath = safePathJoin(publicDir, id);

            const stats = await stat(filePath).catch(() => {});
            if (!stats || !stats.isFile()) {
              return;
            }

            if (id.endsWith('.html')) setHeader(event, 'Content-Type', 'text/html');
            if (id.endsWith('.js')) setHeader(event, 'Content-Type', 'application/javascript');
            if (id.endsWith('.json')) setHeader(event, 'Content-Type', 'application/json');
            if (id.endsWith('.css')) setHeader(event, 'Content-Type', 'text/css');
            if (id.endsWith('.png')) setHeader(event, 'Content-Type', 'image/png');
            if (id.endsWith('.svg')) setHeader(event, 'Content-Type', 'image/svg+xml');

            return {
              size: stats.size,
              mtime: stats.mtimeMs,
            };
          },
        });
      }),
    );

    // Build request listener with optional WEB_PATH prefix rewriting
    // URL rewriting happens BEFORE h3 sees the request, so event.path is correct
    const h3Listener = webPath
      ? (req, res) => {
        const url = req.url || '/';
        if (url === '/') {
          if (REDIRECT_ROOT) {
            res.writeHead(302, { Location: webPath + '/' });
            res.end();
          } else {
            res.writeHead(404, { 'X-Robots-Tag': 'noindex' });
            res.end();
          }
          return;
        }
        if (url.startsWith(webPath + '/')) {
          req.originalUrl = url;
          req.url = url.slice(webPath.length) || '/';
          toNodeListener(app)(req, res);
          return;
        }
        if (url === webPath) {
          res.writeHead(302, { Location: webPath + '/' });
          res.end();
          return;
        }
        res.writeHead(404, { 'X-Robots-Tag': 'noindex' });
        res.end();
      }
      : toNodeListener(app);

    // Initialize API key if not exists
    (async () => {
      try {
        const existingKey = await this.__getApiKey();
        if (!existingKey) {
          const newKey = await this.__generateApiKey();
          // eslint-disable-next-line no-console
          console.log(`[API] Generated new API key: ${newKey}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[API] Failed to initialize API key:', err.message);
      }
    })();

    if (SSL_ENABLED) {
      const certExists = existsSync(SSL_CERT_PATH);
      const keyExists = existsSync(SSL_KEY_PATH);

      // eslint-disable-next-line no-console
      console.log(`[SSL] SSL_ENABLED=true cert_path="${SSL_CERT_PATH}" key_path="${SSL_KEY_PATH}" cert_exists=${certExists} key_exists=${keyExists}`);

      if (!certExists || !keyExists) {
        debug('SSL certificate or key not found, falling back to HTTP...');
        // eslint-disable-next-line no-console
        console.warn('[SSL] Certificate/key file not found. Create certificates manually and set SSL_CERT_PATH/SSL_KEY_PATH. Falling back to HTTP.');
        createServer(h3Listener).listen(PORT, WEBUI_HOST);
        debug(`Listening on http://${WEBUI_HOST}:${PORT}${webPath || ''}`);
        // eslint-disable-next-line no-console
        console.log(`[HTTP] Listening on http://${WEBUI_HOST}:${PORT}${webPath || ''}`);
        cronJobEveryMinute();
        WireGuard.startTrafficHistorySampler().catch((err) => {
          // eslint-disable-next-line no-console
          console.error(err);
        });
        return;
      }

      try {
        const sslOptions = {
          cert: readFileSync(SSL_CERT_PATH),
          key: readFileSync(SSL_KEY_PATH),
        };
        httpolyglot.createServer(sslOptions, (req, res) => {
          if (!req.socket.encrypted) {
            res.writeHead(301, {
              Location: getHttpsRedirectUrl({
                host: req.headers.host,
                url: req.url,
              }),
            });
            res.end();
            return;
          }

          h3Listener(req, res);
        }).listen(PORT, WEBUI_HOST);
        debug(`Listening on https+http redirect://${WEBUI_HOST}:${PORT}`);
        // eslint-disable-next-line no-console
        console.log(`[HTTPS] Listening on https://${WEBUI_HOST}:${PORT}`);
        // eslint-disable-next-line no-console
        console.log(`[HTTP] Redirecting http://${WEBUI_HOST}:${PORT} -> https://${WEBUI_HOST}:${PORT}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[SSL] Failed to start HTTPS with cert="${SSL_CERT_PATH}" key="${SSL_KEY_PATH}":`, err.message);
        // eslint-disable-next-line no-console
        console.error('[SSL] Falling back to HTTP');
        createServer(h3Listener).listen(PORT, WEBUI_HOST);
        debug(`Listening on http://${WEBUI_HOST}:${PORT}${webPath || ''}`);
        // eslint-disable-next-line no-console
        console.log(`[HTTP] Listening on http://${WEBUI_HOST}:${PORT}${webPath || ''}`);
      }
    } else {
      createServer(h3Listener).listen(PORT, WEBUI_HOST);
      const listenPath = webPath || '';
      debug(`Listening on http://${WEBUI_HOST}:${PORT}${listenPath}`);
      // eslint-disable-next-line no-console
      console.log(`[HTTP] Listening on http://${WEBUI_HOST}:${PORT}${listenPath}`);
    }

    cronJobEveryMinute();
    WireGuard.startTrafficHistorySampler().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
    });
  }

  broadcastUiEvent(type, payload = {}) {
    const body = `data: ${JSON.stringify({ type, ...payload, ts: Date.now() })}\n\n`;

    for (const subscriber of [...this.eventSubscribers]) {
      try {
        subscriber.res.write(body);
      } catch {
        this.eventSubscribers.delete(subscriber);
      }
    }
  }

  async __getApiKey() {
    const stored = await this.configStore.getApiKey().catch(() => null);
    return typeof stored?.key === 'string' && stored.key ? stored.key : null;
  }

  async __generateApiKey() {
    const key = 'awg_' + crypto.randomBytes(32).toString('base64url');
    await this.configStore.setApiKey({ key, createdAt: new Date().toISOString() });
    return key;
  }

  async __getEffectiveAuthSettings() {
    const stored = await this.configStore.getAuthSettings().catch(() => null);
    const passwordHash = typeof stored?.passwordHash === 'string' && stored.passwordHash
      ? stored.passwordHash
      : (PASSWORD_HASH || '');
    const password = typeof stored?.password === 'string' && stored.password
      ? stored.password
      : (PASSWORD || '');

    return {
      passwordHash,
      password,
      requiresPassword: !!passwordHash || !!password,
    };
  }

  async __getEffectiveAppSettings() {
    const stored = await this.configStore.getAppSettings().catch(() => null);
    const wgHost = typeof stored?.wgHost === 'string' && stored.wgHost.trim()
      ? stored.wgHost.trim()
      : (typeof require('../config').WG_HOST === 'string' ? require('../config').WG_HOST.trim() : '');
    const defaultDns = typeof stored?.defaultDns === 'string' && stored.defaultDns.trim()
      ? stored.defaultDns.trim()
      : (typeof require('../config').WG_DEFAULT_DNS === 'string' ? require('../config').WG_DEFAULT_DNS.trim() : '1.1.1.1');
    const wgPort = typeof stored?.wgPort === 'string' && stored.wgPort.trim()
      ? stored.wgPort.trim()
      : String(WG_PORT);
    const wgConfigPort = typeof stored?.wgConfigPort === 'string' && stored.wgConfigPort.trim()
      ? stored.wgConfigPort.trim()
      : String(WG_CONFIG_PORT);
    const wgMtu = typeof stored?.wgMtu === 'string'
      ? stored.wgMtu.trim()
      : (WG_MTU || '');
    const wgDefaultAddress = typeof stored?.wgDefaultAddress === 'string' && stored.wgDefaultAddress.trim()
      ? stored.wgDefaultAddress.trim()
      : WG_DEFAULT_ADDRESS;
    const wgAllowedIps = typeof stored?.wgAllowedIps === 'string' && stored.wgAllowedIps.trim()
      ? stored.wgAllowedIps.trim()
      : WG_ALLOWED_IPS;
    const wgPersistentKeepalive = typeof stored?.wgPersistentKeepalive === 'string' && stored.wgPersistentKeepalive.trim()
      ? stored.wgPersistentKeepalive.trim()
      : String(WG_PERSISTENT_KEEPALIVE);

    return {
      wgHost,
      defaultDns,
      wgPort,
      wgConfigPort,
      wgMtu,
      wgDefaultAddress,
      wgAllowedIps,
      wgPersistentKeepalive,
      uiTrafficStats: toBooleanSetting(stored?.uiTrafficStats, UI_TRAFFIC_STATS === 'true'),
      uiChartType: toIntegerSetting(stored?.uiChartType, parseInt(UI_CHART_TYPE, 10) || 0, 0),
      enableOneTimeLinks: toBooleanSetting(stored?.enableOneTimeLinks, WG_ENABLE_ONE_TIME_LINKS === 'true'),
      enableSortClients: toBooleanSetting(stored?.enableSortClients, UI_ENABLE_SORT_CLIENTS === 'true'),
      enableExpireTime: toBooleanSetting(stored?.enableExpireTime, WG_ENABLE_EXPIRES_TIME === 'true'),
      timezone: typeof stored?.timezone === 'string' ? stored.timezone.trim() : '',
      avatarDicebearType: typeof stored?.avatarDicebearType === 'string'
        ? stored.avatarDicebearType.trim()
        : (DICEBEAR_TYPE || ''),
      avatarUseGravatar: toBooleanSetting(stored?.avatarUseGravatar, USE_GRAVATAR === 'true'),
      trafficHistoryEnabled: toBooleanSetting(stored?.trafficHistoryEnabled, TRAFFIC_HISTORY_ENABLED === 'true'),
      trafficSampleIntervalSeconds: toIntegerSetting(stored?.trafficSampleIntervalSeconds, TRAFFIC_SAMPLE_INTERVAL_SECONDS, 1),
      trafficRawRetentionHours: toIntegerSetting(stored?.trafficRawRetentionHours, TRAFFIC_RAW_RETENTION_HOURS, 1),
      trafficMinuteRetentionDays: toIntegerSetting(stored?.trafficMinuteRetentionDays, TRAFFIC_MINUTE_RETENTION_DAYS, 1),
      trafficHourRetentionDays: toIntegerSetting(stored?.trafficHourRetentionDays, TRAFFIC_HOUR_RETENTION_DAYS, 1),
      wgHostConfigured: !!wgHost,
    };
  }

  async __getEffectiveTelegramSettings() {
    const stored = await this.configStore.getTelegramSettings().catch(() => null);
    const token = typeof stored?.token === 'string' && stored.token.trim()
      ? stored.token.trim()
      : (typeof require('../config').TELEGRAM_BOT_TOKEN === 'string' ? require('../config').TELEGRAM_BOT_TOKEN.trim() : '');
    const adminIds = typeof stored?.adminIds === 'string' && stored.adminIds.trim()
      ? stored.adminIds.trim()
      : (require('../config').TELEGRAM_ADMIN_IDS || '');
    const enabled = typeof stored?.enabled === 'boolean'
      ? stored.enabled
      : require('../config').TELEGRAM_BOT_ENABLED === 'true';
    const pollTimeoutSeconds = Math.max(
      1,
      parseInt(stored?.pollTimeoutSeconds, 10) || require('../config').TELEGRAM_BOT_POLL_TIMEOUT_SECONDS
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
      enabled,
      token,
      adminIds,
      pollTimeoutSeconds,
      subscriptionPhoneNumber,
      subscriptionRecipientName,
      subscriptionBankName,
      subscriptionPaymentNote,
    };
  }

  async __getSessionState(event, authenticatedOverride = null) {
    const auth = await this.__getEffectiveAuthSettings();
    const appSettings = await this.__getEffectiveAppSettings();
    const authenticated = authenticatedOverride === null
      ? (auth.requiresPassword
        ? !!(event.node.req.session && event.node.req.session.authenticated)
        : true)
      : authenticatedOverride;

    return {
      requiresPassword: auth.requiresPassword,
      authenticated,
      needsSetup: !auth.requiresPassword || !appSettings.wgHostConfigured,
      wgHostConfigured: appSettings.wgHostConfigured,
      appSettings,
    };
  }

};
