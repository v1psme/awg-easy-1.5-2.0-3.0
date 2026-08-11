'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ConfigStore = require('../lib/ConfigStore');
const Util = require('../lib/Util');

test('ConfigStore retries sqlite database is locked errors', async () => {
  const store = new ConfigStore({
    basePath: '/tmp/wg-easy-test',
  });

  let attempts = 0;
  const originalExecFile = Util.execFile;
  Util.execFile = async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('database is locked');
    }

    return 'ok';
  };

  try {
    const result = await store.__execSqliteWithRetry(['dummy'], {
      errorPrefix: 'sqlite failed',
      retries: 4,
      delayMs: 1,
    });

    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  } finally {
    Util.execFile = originalExecFile;
  }
});

test('ConfigStore stops retrying on non-lock sqlite errors', async () => {
  const store = new ConfigStore({
    basePath: '/tmp/wg-easy-test',
  });

  const originalExecFile = Util.execFile;
  Util.execFile = async () => {
    throw new Error('permission denied');
  };

  try {
    await assert.rejects(
      () => store.__execSqliteWithRetry(['dummy'], {
        errorPrefix: 'sqlite failed',
        retries: 4,
        delayMs: 1,
      }),
      /sqlite failed: permission denied/
    );
  } finally {
    Util.execFile = originalExecFile;
  }
});
