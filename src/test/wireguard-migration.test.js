'use strict';

// Тесты миграций WireGuard.js (таймеры v3 + per-I мимикрия).
// Требуют node_modules (qrcode/debug/sqlite) — на хосте без npm ci
// файл скипается целиком; в Docker-контейнере прогоняется полностью.

const test = require('node:test');
const assert = require('node:assert/strict');

let WireGuard = null;
let gate = false; // NB: node:test трактует skip: null как SKIP — нужен именно false
try {
    WireGuard = require('../lib/WireGuard');
} catch (e) {
    gate = `WireGuard deps missing on host (${e.message.split('\n')[0]}) — run with npm ci / in Docker`;
}

const CONFIG_PATH = require.resolve('../config');
const flushConfig = () => delete require.cache[CONFIG_PATH];

const withEnv = (env, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        flushConfig();
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        flushConfig();
    }
};

const migrateTimers = (server, env = {}) => withEnv({ AMNEZIA_VERSION: '3', ...env }, () => {
    const cfg = require('../config');
    const wg = Object.create(WireGuard.prototype);
    wg.__migrateHeaderProtection({ server });
    void cfg;
    return server;
});

const migrateMimicry = (server, env = {}) => withEnv({ AMNEZIA_VERSION: '3', ...env }, () => {
    const wg = Object.create(WireGuard.prototype);
    wg.__migrateMimicryProfile({ server });
    return server;
});

const U16RANGE = /^\d+(-\d+)?$/;

test('timers: generated once on empty config, stable afterwards', { skip: gate }, () => {
    const s1 = migrateTimers({});
    for (const p of ['contentPaddingAddition', 'rekeyAfterTime', 'rekeyTimeout', 'rejectAfterTime', 'keepaliveTimeout', 'maxHandshakeAttempts']) {
        assert.match(s1[p], U16RANGE, `${p} is a u16_range`);
    }
    const [rjtLo] = s1.rejectAfterTime.split('-').map(Number);
    const [, ratHi] = s1.rekeyAfterTime.split('-').map(Number);
    assert.ok(rjtLo > ratHi, 'invariant RejectAfterTime > RekeyAfterTime');
    const snapshot = { ...s1 };
    migrateTimers(s1);
    assert.deepEqual(s1, snapshot, 'second run does not rotate');
});

test('timers: env pin rotates persisted, (off) clears it', { skip: gate }, () => {
    const s = migrateTimers({}, { REKEY_AFTER_TIME: '150-170', KEEPALIVE_TIMEOUT: '22' });
    assert.equal(s.rekeyAfterTime, '150-170');
    assert.equal(s.keepaliveTimeout, '22');
    migrateTimers(s, { REKEY_AFTER_TIME: '(off)' });
    assert.equal(s.rekeyAfterTime, '', '(off) removes the field (protocol default)');
    migrateTimers(s, {});
    assert.equal(s.rekeyAfterTime, '', 'after off: env unset leaves it cleared (persisted)');
    assert.equal(s.keepaliveTimeout, '22', 'other pin untouched');
});

test('timers: invalid pin does not rotate existing persisted value', { skip: gate }, () => {
    const s = migrateTimers({}, {});
    const before = s.rekeyAfterTime;
    migrateTimers(s, { REKEY_AFTER_TIME: 'bogus' });
    assert.equal(s.rekeyAfterTime, before, 'invalid pin → config.js fallback, persisted kept');
});

test('mimicry: global tls → I1 TLS, I2-I5 dns, markers persisted, stable', { skip: gate }, () => {
    const s = migrateMimicry({}, { MIMICRY_PROFILE: 'tls' });
    assert.match(s.i1, /^<b 0x16/, 'I1 is a TLS record');
    assert.match(s.i2, /^<r \d+><b 0x[0-9a-f]+>$/, 'I2 is DNS format (QUIC/TLS I1-only rule)');
    assert.equal(s.mimicryProfile, 'tls');
    assert.equal(s.mimicryProfileI1, 'tls');
    assert.equal(s.mimicryProfileI2, 'dns');
    assert.equal(s.mimicryProfileI5, 'dns');
    const snapshot = { ...s };
    migrateMimicry(s, { MIMICRY_PROFILE: 'tls' });
    assert.deepEqual(s, snapshot, 'second run: tuple matches, no regeneration');
});

test('mimicry: per-I env vars → markers and formats', { skip: gate }, () => {
    const s = migrateMimicry({}, { MIMICRY_PROFILE_I1: 'quic', MIMICRY_PROFILE_I2: 'sip' });
    const hexOf = (cps) => Buffer.from(cps.match(/^<b 0x([0-9a-f]+)>$/)[1], 'hex');
    assert.equal(hexOf(s.i1).length, 1200, 'I1 QUIC Initial');
    assert.equal(hexOf(s.i2).toString('ascii').slice(0, 8), 'REGISTER', 'I2 SIP');
    assert.match(s.i3, /^<r \d+><b 0x[0-9a-f]+>$/, 'I3 dns (global-derived)');
    assert.equal(s.mimicryProfileI1, 'quic');
    assert.equal(s.mimicryProfileI2, 'sip');
    assert.equal(s.mimicryProfileI3, 'dns');
});

test('mimicry: I2-I5 clamp tls → dns', { skip: gate }, () => {
    const s = migrateMimicry({}, { MIMICRY_PROFILE_I2: 'tls' });
    assert.match(s.i2, /^<r \d+><b 0x[0-9a-f]+>$/, 'clamped to dns format');
    assert.equal(s.mimicryProfileI2, 'dns');
});

test('mimicry: env pins I1..I5 win over generated values', { skip: gate }, () => {
    const s = migrateMimicry({}, { MIMICRY_PROFILE: 'tls', I2: '<b 0x1234>' });
    assert.equal(s.i2, '<b 0x1234>', 'pin preserved');
    assert.match(s.i1, /^<b 0x16/, 'I1 still generated (tls)');
});

test('mimicry: pins-only env (no MIMICRY_*) now applies to persisted config', { skip: gate }, () => {
    // pre-existing баг: раньше метод делал no-op и пины не доезжали
    const s = migrateMimicry({ server: {} }, { I2: '<b 0xabcd>', I5: '' });
    assert.equal(s.i2, '<b 0xabcd>', 'I2 pin applied');
    assert.equal(s.i5, '', 'empty pin = disabled');
});

test('mimicry: no env at all → no-op on existing marked config', { skip: gate }, () => {
    const marked = { server: { mimicryProfile: 'dns', mimicryBrowser: 'chrome', i1: '<b 0xAA>', i2: '' } };
    const s = migrateMimicry(marked.server, {});
    assert.deepEqual(s, marked.server, 'untouched without any MIMICRY_*/I* env');
});
