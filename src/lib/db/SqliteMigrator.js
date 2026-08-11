'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Util = require('../Util');
const ServerError = require('../ServerError');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const parseJsonRows = (stdout) => {
  if (!stdout) {
    return [];
  }

  const rows = JSON.parse(stdout);
  return Array.isArray(rows) ? rows : [];
};

module.exports = class SqliteMigrator {

  constructor({
    dbPath,
    basePath,
  }) {
    this.dbPath = dbPath;
    this.basePath = basePath || path.dirname(dbPath);
    this.backupDir = path.join(this.basePath, 'db-backups');
    this.initPromise = null;
  }

  async migrate() {
    if (!this.initPromise) {
      this.initPromise = this.__migrateAsync();
    }

    return this.initPromise;
  }

  migrateSync() {
    fs.mkdirSync(this.basePath, { recursive: true });
    this.__ensureMigrationTableSync();
    const migrations = this.__loadMigrationsSync();
    const appliedVersions = new Set(this.__getAppliedVersionsSync());
    const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

    if (pending.length === 0) {
      return [];
    }

    this.__backupDatabaseSync();

    for (const migration of pending) {
      const sql = [
        'BEGIN;',
        migration.sql,
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name.replace(/'/g, '\'\'')}', CURRENT_TIMESTAMP);`,
        'COMMIT;',
      ].join('\n');

      execFileSync('sqlite3', [
        this.dbPath,
        sql,
      ], {
        encoding: 'utf8',
      });
    }

    return pending.map((migration) => migration.version);
  }

  async __migrateAsync() {
    await fsp.mkdir(this.basePath, { recursive: true });
    await this.__ensureMigrationTableAsync();
    const migrations = await this.__loadMigrationsAsync();
    const appliedVersions = new Set(await this.__getAppliedVersionsAsync());
    const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

    if (pending.length === 0) {
      return [];
    }

    await this.__backupDatabaseAsync();

    for (const migration of pending) {
      const sql = [
        'BEGIN;',
        migration.sql,
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name.replace(/'/g, '\'\'')}', CURRENT_TIMESTAMP);`,
        'COMMIT;',
      ].join('\n');

      await Util.execFile('sqlite3', [
        this.dbPath,
        sql,
      ], {
        log: false,
      }).catch((err) => {
        throw new ServerError(`Failed to apply SQLite migration ${migration.name}: ${err.message}`, 500);
      });
    }

    return pending.map((migration) => migration.version);
  }

  async __ensureMigrationTableAsync() {
    await Util.execFile('sqlite3', [
      this.dbPath,
      `
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      `,
    ], {
      log: false,
    }).catch((err) => {
      throw new ServerError(`Failed to initialize SQLite migration table: ${err.message}`, 500);
    });
  }

  __ensureMigrationTableSync() {
    execFileSync('sqlite3', [
      this.dbPath,
      `
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      `,
    ], {
      encoding: 'utf8',
    });
  }

  async __getAppliedVersionsAsync() {
    const stdout = await Util.execFile('sqlite3', [
      '-json',
      this.dbPath,
      'SELECT version FROM schema_migrations ORDER BY version ASC;',
    ], {
      log: false,
    }).catch((err) => {
      throw new ServerError(`Failed to query SQLite schema versions: ${err.message}`, 500);
    });

    return parseJsonRows(stdout).map((row) => Number(row.version)).filter(Number.isInteger);
  }

  __getAppliedVersionsSync() {
    const stdout = execFileSync('sqlite3', [
      '-json',
      this.dbPath,
      'SELECT version FROM schema_migrations ORDER BY version ASC;',
    ], {
      encoding: 'utf8',
    });

    return parseJsonRows(stdout).map((row) => Number(row.version)).filter(Number.isInteger);
  }

  async __loadMigrationsAsync() {
    const entries = await fsp.readdir(MIGRATIONS_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();

    return Promise.all(files.map(async (file) => {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const sql = await fsp.readFile(fullPath, 'utf8');
      const version = parseInt(file.split('_', 1)[0], 10);

      if (!Number.isInteger(version)) {
        throw new ServerError(`Invalid SQLite migration filename: ${file}`, 500);
      }

      return {
        version,
        name: file,
        sql,
      };
    }));
  }

  __loadMigrationsSync() {
    const files = fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();

    return files.map((file) => {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const version = parseInt(file.split('_', 1)[0], 10);

      if (!Number.isInteger(version)) {
        throw new Error(`Invalid SQLite migration filename: ${file}`);
      }

      return {
        version,
        name: file,
        sql: fs.readFileSync(fullPath, 'utf8'),
      };
    });
  }

  async __backupDatabaseAsync() {
    try {
      await fsp.access(this.dbPath);
    } catch {
      return null;
    }

    await fsp.mkdir(this.backupDir, { recursive: true });
    const target = path.join(this.backupDir, `wg-easy-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await fsp.copyFile(this.dbPath, target);
    return target;
  }

  __backupDatabaseSync() {
    if (!fs.existsSync(this.dbPath)) {
      return null;
    }

    fs.mkdirSync(this.backupDir, { recursive: true });
    const target = path.join(this.backupDir, `wg-easy-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    fs.copyFileSync(this.dbPath, target);
    return target;
  }

};
