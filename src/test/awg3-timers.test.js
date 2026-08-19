'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const timers = require('../lib/awg3-timers');

const { generateAwg3Timers, normalizeU16Range, PROTOCOL_DEFAULTS } = timers;

// Детерминированный rnd: всегда нижняя граница
const loRnd = { int: (a) => a };
// Скриптованный rnd: очередь значений, потом циклит последнее
const scriptRnd = (values) => {
    const queue = [...values];
    return {
        int: () => (queue.length > 1 ? queue.shift() : queue[0]),
    };
};

const splitRange = (s) => {
    const m = s.match(/^(\d+)(?:-(\d+))?$/);
    assert.ok(m, `invalid u16_range: ${s}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    return [lo, hi];
};

test('generateAwg3Timers: deterministic lower bounds', () => {
    const t = generateAwg3Timers(loRnd);
    // loRnd → все rand берут нижние границы: cpa 8-48, rat 110-140,
    // rjt: 175 > 140+15 ✓ и 200 > 175+20 ✓ → 175-200, ka 9-20, rkt 4-10, mha 16
    assert.deepEqual(t, {
        contentPaddingAddition: '8-48',
        rekeyAfterTime: '110-140',
        rekeyTimeout: '4-10',
        rejectAfterTime: '175-200',
        keepaliveTimeout: '9-20',
        maxHandshakeAttempts: '16',
    });
});

test('generateAwg3Timers: invariant guard retries a bad draw', () => {
    // Первый розыгрыш rjt: lo=175 при rat_hi=160 → 175 > 175 ложно → retry.
    // Второй: lo=176, hi=200 → 176 > 175 ✓ и 200 > 196 ✓.
    const rnd = scriptRnd([8, 48, 110, 160, 175, 200, 176, 200, 9, 20, 16]);
    const t = generateAwg3Timers(rnd);
    assert.equal(t.rejectAfterTime, '176-200');
    const [rjtLo] = splitRange(t.rejectAfterTime);
    assert.ok(rjtLo > 160 + 15, 'reject lo > rekey hi + 15');
});

test('generateAwg3Timers: invariants over 500 real-random iterations', () => {
    for (let i = 0; i < 500; i++) {
        const t = generateAwg3Timers();
        for (const key of Object.keys(t)) {
            assert.match(t[key], /^\d+(-\d+)?$/, `${key} format: ${t[key]}`);
            const [lo, hi] = splitRange(t[key]);
            assert.ok(lo <= hi, `${key} LO <= HI`);
            assert.ok(hi <= 65535, `${key} inside uint16`);
        }
        const [ratLo, ratHi] = splitRange(t.rekeyAfterTime);
        const [rjtLo, rjtHi] = splitRange(t.rejectAfterTime);
        assert.ok(rjtLo > ratHi + 15, `reject lo > rekey hi + 15 (rat=${t.rekeyAfterTime}, rjt=${t.rejectAfterTime})`);
        assert.ok(rjtHi > rjtLo + 20, `reject hi > reject lo + 20`);
        assert.ok(rjtLo > ratHi, 'invariant RejectAfterTime > RekeyAfterTime');
        // Полосы охватывают протокольные дефолты
        const [cpaLo, cpaHi] = splitRange(t.contentPaddingAddition);
        assert.ok(cpaLo >= 8, 'content padding lo >= 8 (0 = off)');
        assert.ok(cpaLo <= cpaHi);
        const [kaLo, kaHi] = splitRange(t.keepaliveTimeout);
        // Полоса «вокруг 10»: lo 9-14, hi 20-30 (дефолт 10 в полосе не гарантирован)
        assert.ok(kaLo >= 9 && kaLo <= 14 && kaHi >= 20 && kaHi <= 30);
        // Полоса «вокруг 120»: lo 110-125, hi 140-160
        assert.ok(ratLo >= 110 && ratLo <= 125 && ratHi >= 140 && ratHi <= 160);
        // Полоса «вокруг 180»: lo 175-190, hi 200-215 (дефолт 180 в полосе не гарантирован)
        assert.ok(rjtLo >= 175 && rjtLo <= 190 && rjtHi >= 200 && rjtHi <= 215);
        const [rktLo, rktHi] = splitRange(t.rekeyTimeout);
        assert.ok(rktLo <= PROTOCOL_DEFAULTS.rekeyTimeout && PROTOCOL_DEFAULTS.rekeyTimeout <= rktHi);
        assert.ok(Number(t.maxHandshakeAttempts) >= 16 && Number(t.maxHandshakeAttempts) <= 20);
    }
});

test('normalizeU16Range: valid inputs', () => {
    assert.equal(normalizeU16Range('120'), '120');
    assert.equal(normalizeU16Range('100-145'), '100-145');
    assert.equal(normalizeU16Range(' 12-24 '), '12-24');
    assert.equal(normalizeU16Range('0'), '0');
    assert.equal(normalizeU16Range('65535'), '65535');
    assert.equal(normalizeU16Range('(off)'), '');
    assert.equal(normalizeU16Range(' (Off) '), '');
});

test('normalizeU16Range: invalid inputs → null', () => {
    for (const bad of ['', '   ', 'abc', 'OFF', '10-', '-5', '10-5', '10-20-30', '1.5-2', '70000', '70000-80000', '10-70000', null, undefined]) {
        assert.equal(normalizeU16Range(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});
