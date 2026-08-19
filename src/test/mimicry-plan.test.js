'use strict';

// resolveMimicryPlan — чистая функция: env передаётся аргументом, process.env не трогает.
const test = require('node:test');
const assert = require('node:assert/strict');

// config.js при require читает process.env — изолируем только resolveMimicryPlan
// через собственный свежий require в каждом тесте (кэш чистится).
const loadPlan = () => {
    const path = require.resolve('../config');
    delete require.cache[path];
    return require('../config').resolveMimicryPlan;
};

test('resolveMimicryPlan: empty env → legacy dns, perI undefined, yandex.com default', () => {
    const p = loadPlan()({});
    assert.equal(p.profile, 'dns');
    assert.equal(p.browser, 'chrome');
    assert.equal(p.browserI1, 'chrome');
    assert.equal(p.domain, '');
    assert.equal(p.region, 'world');
    assert.equal(p.onlyI1, false);
    assert.equal(p.defaultDomain, 'yandex.com');
    assert.equal(p.perI, undefined);
    assert.deepEqual(p.warnings, []);
});

test('resolveMimicryPlan: region ru → yandex.ru', () => {
    const p = loadPlan()({ MIMICRY_REGION: 'ru' });
    assert.equal(p.region, 'ru');
    assert.equal(p.defaultDomain, 'yandex.ru');
});

test('resolveMimicryPlan: global tls/quic → I1 keeps profile, I2-I5 become dns', () => {
    for (const profile of ['tls', 'quic']) {
        const p = loadPlan()({ MIMICRY_PROFILE: profile });
        assert.deepEqual(p.perI, { 1: profile, 2: 'dns', 3: 'dns', 4: 'dns', 5: 'dns' });
    }
    const dnsPlan = loadPlan()({ MIMICRY_PROFILE: 'dns' });
    assert.equal(dnsPlan.perI, undefined, 'dns stays legacy path');
    const sipPlan = loadPlan()({ MIMICRY_PROFILE: 'sip' });
    assert.equal(sipPlan.perI, undefined, 'sip stays legacy path');
});

test('resolveMimicryPlan: per-I I1 alone', () => {
    const p = loadPlan()({ MIMICRY_PROFILE_I1: 'quic' });
    assert.deepEqual(p.perI, { 1: 'quic', 2: 'dns', 3: 'dns', 4: 'dns', 5: 'dns' });
});

test('resolveMimicryPlan: I2-I5 clamp — tls/quic/unknown → dns + warning; sip passes', () => {
    const tls = loadPlan()({ MIMICRY_PROFILE_I2: 'tls' });
    assert.equal(tls.perI[2], 'dns');
    assert.equal(tls.warnings.length, 1);
    assert.match(tls.warnings[0], /not allowed for I2-I5/);
    const quic = loadPlan()({ MIMICRY_PROFILE_I4: 'quic' });
    assert.equal(quic.perI[4], 'dns');
    assert.equal(quic.warnings.length, 1);
    const bogus = loadPlan()({ MIMICRY_PROFILE_I3: 'bogus' });
    assert.equal(bogus.perI[3], 'dns');
    assert.equal(bogus.warnings.length, 1);
    const sip = loadPlan()({ MIMICRY_PROFILE_I2: 'sip' });
    assert.equal(sip.perI[2], 'sip');
    assert.deepEqual(sip.warnings, []);
});

test('resolveMimicryPlan: precedence — per-I beats global; env-pins applied later', () => {
    const p = loadPlan()({ MIMICRY_PROFILE: 'tls', MIMICRY_PROFILE_I1: 'sip' });
    assert.deepEqual(p.perI, { 1: 'sip', 2: 'dns', 3: 'dns', 4: 'dns', 5: 'dns' });
    const p2 = loadPlan()({ MIMICRY_PROFILE: 'tls', MIMICRY_PROFILE_I2: 'sip' });
    assert.deepEqual(p2.perI, { 1: 'tls', 2: 'sip', 3: 'dns', 4: 'dns', 5: 'dns' });
});

test('resolveMimicryPlan: browserI1 — valid wins, invalid falls back + warning', () => {
    const p = loadPlan()({ MIMICRY_BROWSER: 'firefox', MIMICRY_BROWSER_I1: 'safari' });
    assert.equal(p.browser, 'firefox');
    assert.equal(p.browserI1, 'safari');
    assert.deepEqual(p.warnings, []);
    const bad = loadPlan()({ MIMICRY_BROWSER: 'chrome', MIMICRY_BROWSER_I1: 'bogus' });
    assert.equal(bad.browserI1, 'chrome');
    assert.equal(bad.warnings.length, 1);
});

test('resolveMimicryPlan: unknown global profile/browser → fallback + warning (as before)', () => {
    const p = loadPlan()({ MIMICRY_PROFILE: 'bogus', MIMICRY_BROWSER: 'lynx' });
    assert.equal(p.profile, 'dns');
    assert.equal(p.browser, 'chrome');
    assert.equal(p.warnings.length, 2);
});

test('resolveMimicryPlan: domain trimmed, onlyI1, case-insensitive values', () => {
    const p = loadPlan()({ MIMICRY_DOMAIN: '  Example.COM ', MIMICRY_ONLY_I1: 'true', MIMICRY_PROFILE_I1: 'QUIC' });
    assert.equal(p.domain, 'example.com');
    assert.equal(p.onlyI1, true);
    assert.equal(p.perI[1], 'quic');
});
