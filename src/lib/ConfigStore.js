'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const Util = require('./Util');
const ServerError = require('./ServerError');
const SqliteMigrator = require('./db/SqliteMigrator');

module.exports = class ConfigStore {

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
      this.initPromise = Promise.resolve().then(async () => {
        await fs.mkdir(this.basePath, { recursive: true });
        await this.migrator.migrate().catch((err) => {
          throw new ServerError(`Failed to initialize SQLite config store: ${err.message}`, 500);
        });
      });
    }

    return this.initPromise;
  }

  async getConfig() {
    return this.getJson('wireguard_config', {
      errorPrefix: 'Failed to read config from SQLite',
    });
  }

  async setConfig(config) {
    return this.setJson('wireguard_config', config, {
      errorPrefix: 'Failed to write config to SQLite',
    });
  }

  async getAppSettings() {
    return this.getJson('app_settings', {
      errorPrefix: 'Failed to read app settings from SQLite',
    });
  }

  async setAppSettings(settings) {
    return this.setJson('app_settings', settings, {
      errorPrefix: 'Failed to write app settings to SQLite',
    });
  }

  async getAuthSettings() {
    return this.getJson('auth_settings', {
      errorPrefix: 'Failed to read auth settings from SQLite',
    });
  }

  async setAuthSettings(settings) {
    return this.setJson('auth_settings', settings, {
      errorPrefix: 'Failed to write auth settings to SQLite',
    });
  }

  async getTelegramSettings() {
    return this.getJson('telegram_settings', {
      errorPrefix: 'Failed to read Telegram settings from SQLite',
    });
  }

  async setTelegramSettings(settings) {
    return this.setJson('telegram_settings', settings, {
      errorPrefix: 'Failed to write Telegram settings to SQLite',
    });
  }

  async getJson(key, {
    errorPrefix = 'Failed to read JSON from SQLite',
  } = {}) {
    await this.init();

    const stdout = await this.__execSqliteWithRetry([
      '-json',
      this.dbPath,
      `SELECT value FROM app_state WHERE key = '${String(key).replace(/'/g, '\'\'')}' LIMIT 1;`,
    ], {
      errorPrefix,
    });

    if (!stdout) {
      return null;
    }

    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0].value !== 'string') {
      return null;
    }

    return JSON.parse(rows[0].value);
  }

  async setJson(key, value, {
    errorPrefix = 'Failed to write JSON to SQLite',
  } = {}) {
    await this.init();

    const json = JSON.stringify(value, null, 2);
    const tempPath = path.join(os.tmpdir(), `wg-easy-config-${process.pid}-${Date.now()}.json`);

    await fs.writeFile(tempPath, json, { mode: 0o600 });

    try {
      await this.__execSqliteWithRetry([
        this.dbPath,
        `
        INSERT INTO app_state (key, value, updated_at)
        VALUES ('${String(key).replace(/'/g, '\'\'')}', CAST(readfile('${tempPath.replace(/'/g, '\'\'')}') AS TEXT), CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP;
        `,
      ], {
        errorPrefix,
      });
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async __execSqliteWithRetry(args, {
    errorPrefix,
    retries = 6,
    delayMs = 80,
  }) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await Util.execFile('sqlite3', args, {
          log: false,
        });
      } catch (err) {
        lastError = err;
        if (!err.message || !err.message.includes('database is locked') || attempt === retries) {
          throw new ServerError(`${errorPrefix}: ${err.message}`, 500);
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }

    throw new ServerError(`${errorPrefix}: ${lastError ? lastError.message : 'Unknown SQLite error'}`, 500);
  }

};
