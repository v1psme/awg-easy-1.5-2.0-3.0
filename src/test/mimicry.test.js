'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mimicry = require('../lib/mimicry');

const isGreaseU16 = (v) => {
    const hi = (v >> 8) & 0xFF;
    const lo = v & 0xFF;
    return hi === lo && (lo & 0x0F) === 0x0A;
};

// Разбор TLS ClientHello record → {version, ciphers, exts:[{type, data}]}
const parseClientHello = (buf) => {
    assert.equal(buf[0], 0x16, 'TLS record type');
    assert.deepEqual([buf[1], buf[2]], [0x03, 0x01], 'TLS record version');
    const recLen = buf.readUInt16BE(3);
    assert.equal(recLen, buf.length - 5, 'TLS record length');
    assert.equal(buf[5], 0x01, 'handshake type');
    let off = 9; // record(5) + hs type(1) + hs len(3)
    const version = buf.readUInt16BE(off); off += 2;
    off += 32; // random
    const sidLen = buf[off]; off += 1 + sidLen;
    const cipherLen = buf.readUInt16BE(off); off += 2;
    const ciphers = [];
    for (let i = 0; i < cipherLen / 2; i++) {
        ciphers.push(buf.readUInt16BE(off));
        off += 2;
    }
    const compLen = buf[off]; off += 1 + compLen; // compression methods
    const extLen = buf.readUInt16BE(off); off += 2;
    const end = off + extLen;
    const exts = [];
    while (off < end) {
        const type = buf.readUInt16BE(off);
        const len = buf.readUInt16BE(off + 2);
        exts.push({ type, data: buf.subarray(off + 4, off + 4 + len) });
        off += 4 + len;
    }
    return { version, ciphers, exts };
};

const parseSNI = (ch) => {
    const sni = ch.exts.find((e) => e.type === 0x0000);
    assert.ok(sni, 'SNI extension present');
    // data: listLen(2) + nameType(1) + nameLen(2) + name
    const nameLen = sni.data.readUInt16BE(3);
    return sni.data.subarray(5, 5 + nameLen).toString('ascii');
};

const hexOf = (cps) => {
    const m = cps.match(/^<b 0x([0-9a-f]+)>$/);
    assert.ok(m, `expected <b 0xHEX> format, got: ${cps.slice(0, 40)}...`);
    return Buffer.from(m[1], 'hex');
};
const dnsHexOf = (cps) => {
    const m = cps.match(/^<r \d+><b 0x([0-9a-f]+)>$/);
    assert.ok(m, `expected DNS <r N><b 0xHEX> format, got: ${cps.slice(0, 40)}...`);
    return Buffer.from(m[1], 'hex');
};

// === DNS ===

test('buildDNSMimic: structure of the proven DNS-response packet', () => {
    const val = mimicry.buildDNSMimic('google.com', '1.2.3.4', { rMin: 2, rMax: 40 });
    const m = val.match(/^<r (\d+)><b 0x([0-9a-f]+)>$/);
    assert.ok(m, 'format <r N><b 0xHEX>');
    const rLen = parseInt(m[1], 10);
    assert.ok(rLen >= 2 && rLen <= 40, `r length ${rLen} in [2,40]`);
    const pkt = Buffer.from(m[2], 'hex');
    // header: TXID(2) + 0001000100000000
    assert.deepEqual([...pkt.subarray(2, 10)], [0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
    // question: 06 'google' 03 'com' 00 0001 0001 (offset 10..26)
    assert.deepEqual([...pkt.subarray(10, 26)],
        [0x06, ...Buffer.from('google'), 0x03, ...Buffer.from('com'), 0x00, 0x00, 0x01, 0x00, 0x01]);
    // answer: c00c 0001 0001 0000105a 0004 + ip octets (offset 26)
    const ans = pkt.subarray(26);
    assert.deepEqual([...ans.subarray(0, 12)],
        [0xC0, 0x0C, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x10, 0x5A, 0x00, 0x04]);
    assert.deepEqual([...ans.subarray(12)], [1, 2, 3, 4], 'answer IP octets');
});

test('generateProfile dns: default all-5 with junk I2-I5, onlyI1 empties them', () => {
    const all = mimicry.generateProfile({ profile: 'dns', dnsSites: ['icloud.com'], rMin: 2, rMax: 40 });
    assert.match(all.i1, /^<r \d+><b 0x[0-9a-f]+>$/);
    assert.match(all.i2, /^<b 0x[0-9a-f]{32}><r \d+>$/, 'I2 junk format');
    assert.match(all.i5, /^<b 0x[0-9a-f]{32}><r \d+>$/, 'I5 junk format');
    const only = mimicry.generateProfile({ profile: 'dns', onlyI1: true });
    assert.notEqual(only.i1, '');
    assert.equal(only.i2, '');
    assert.equal(only.i3, '');
    assert.equal(only.i4, '');
    assert.equal(only.i5, '');
    const dnsAll = mimicry.generateProfile({ profile: 'dns', dnsMimicAll: true });
    assert.match(dnsAll.i2, /^<r \d+><b 0x[0-9a-f]+>$/, 'dnsMimicAll: I2 also DNS format');
});

// === TLS ===

test('genTlsClientHello chrome: record header, GREASE, SNI, ALPS, light padding', () => {
    const buf = mimicry.genTlsClientHello('example.com', 'chrome');
    const ch = parseClientHello(buf);
    assert.equal(parseSNI(ch), 'example.com');
    assert.ok(isGreaseU16(ch.ciphers[0]), 'GREASE cipher first');
    assert.ok(ch.exts.some((e) => isGreaseU16(e.type)), 'GREASE extension type');
    assert.ok(ch.exts.some((e) => e.type === 0x4469), 'ALPS extension');
    assert.ok(ch.exts.some((e) => e.type === 0x001B), 'compress_certificate');
    const pad = ch.exts.filter((e) => e.type === 0x0015);
    assert.ok(pad.length <= 1, 'at most one padding ext');
    if (pad.length) assert.ok(pad[0].data.length <= 48, 'chrome padding <= 48');
    assert.ok(buf.length < 600, `chrome ClientHello < 600 bytes (got ${buf.length})`);
});

test('genTlsClientHello firefox: NSS shape, no GREASE, delegated_credentials, padded to 512', () => {
    const buf = mimicry.genTlsClientHello('example.com', 'firefox');
    const ch = parseClientHello(buf);
    assert.equal(parseSNI(ch), 'example.com');
    assert.equal(buf.length, 512, 'Firefox pads the record to 512 bytes');
    assert.ok(!ch.ciphers.some(isGreaseU16), 'no GREASE cipher');
    assert.ok(!ch.exts.some((e) => isGreaseU16(e.type)), 'no GREASE extension');
    assert.ok(ch.exts.some((e) => e.type === 0x0022), 'delegated_credentials');
    assert.ok(ch.exts.some((e) => e.type === 0x0015), 'padding ext');
    assert.ok(ch.exts.some((e) => e.type === 0xFF01), 'renegotiation_info (NSS sends it)');
});

test('genTlsClientHello safari: SecureTransport shape, TLS1.1, dual key_share, no GREASE', () => {
    const buf = mimicry.genTlsClientHello('example.com', 'safari');
    const ch = parseClientHello(buf);
    assert.equal(parseSNI(ch), 'example.com');
    assert.ok(!ch.ciphers.some(isGreaseU16), 'no GREASE cipher');
    assert.ok(!ch.exts.some((e) => isGreaseU16(e.type)), 'no GREASE extension');
    assert.ok(!ch.exts.some((e) => e.type === 0x0015), 'no padding ext');
    const sv = ch.exts.find((e) => e.type === 0x002B);
    assert.ok(sv, 'supported_versions');
    const svList = [];
    for (let i = 1; i < sv.data.length; i += 2) svList.push(sv.data.readUInt16BE(i));
    assert.ok(svList.includes(0x0302), 'TLS 1.1 advertised (Apple)');
    const ks = ch.exts.find((e) => e.type === 0x0033);
    assert.ok(ks, 'key_share');
    let off = 2;
    const entries = [];
    while (off < ks.data.length) {
        const group = ks.data.readUInt16BE(off);
        const len = ks.data.readUInt16BE(off + 2);
        entries.push({ group, len });
        off += 4 + len;
    }
    assert.deepEqual(entries.map((e) => [e.group, e.len]),
        [[0x001D, 32], [0x0017, 65]], 'x25519 + secp256r1 (both, Apple style)');
    assert.deepEqual([ch.ciphers[0], ch.ciphers[1], ch.ciphers[2]], [0x1301, 0x1302, 0x1303]);
});

// === QUIC ===

test('QUIC crypto core matches RFC 9001 initial secret vectors', () => {
    const salt = mimicry.QUIC_INITIAL_SALT;
    const dcid = Buffer.from('8394c8f03e515708', 'hex');
    const initialSecret = mimicry.hkdfExtract(salt, dcid);
    assert.equal(initialSecret.toString('hex'),
        '7db5df06e7a69e432496adedb00851923595221596ae2ae9fb8115c1e9ed0a44');
    const clientSecret = mimicry.hkdfExpandLabel(initialSecret, 'client in', 32);
    assert.equal(clientSecret.toString('hex'),
        'c00cf151ca5be075ed0ebfb5c80323c42d6b7db67881289af4008f1f6c357aea');
});

test('genQuicInitial: long header, v1, 1200 bytes, payload encrypted (no plaintext SNI)', () => {
    const { packet, dcid } = mimicry.genQuicInitial('example.com', 'chrome');
    assert.equal(packet.length, 1200);
    assert.equal(packet[0] & 0xC0, 0xC0, 'long header form');
    assert.deepEqual([...packet.subarray(1, 5)], [0x00, 0x00, 0x00, 0x01], 'QUIC v1');
    assert.equal(packet[5], 8, 'dcid length');
    assert.deepEqual(dcid, packet.subarray(6, 14));
    // Real Initial protection hides the ClientHello/SNI — plaintext would be
    // a tell; the masked fallback would expose it, so this also proves the
    // encryption path ran.
    assert.ok(!packet.includes(Buffer.from('example.com')), 'SNI not visible in plaintext');
});

test('genQuicSecondInitial: same dcid, 300-600 bytes', () => {
    const { packet, dcid, version } = mimicry.genQuicInitial('example.com');
    const pkt = mimicry.genQuicSecondInitial(dcid, version);
    assert.ok(pkt.length >= 300 && pkt.length <= 600, `length ${pkt.length}`);
    assert.ok(pkt[0] === 0xC0 || pkt[0] === 0xC3, 'first byte');
    assert.deepEqual(pkt.subarray(6, 14), dcid, 'dcid carried from I1');
});

test('genQuicShort: short header, small packet', () => {
    const pkt = mimicry.genQuicShort();
    assert.notEqual(pkt[0] & 0x40, 0, 'short header bit set');
    assert.ok(pkt.length < 120, `short packet < 120 bytes (got ${pkt.length})`);
});

// === SIP ===

test('genSip: REGISTER structure', () => {
    const buf = mimicry.genSip('sip.example.com');
    const text = buf.toString('ascii');
    assert.ok(text.startsWith('REGISTER sip:sip.example.com SIP/2.0\r\n'));
    assert.match(text, /Via: SIP\/2\.0\/(UDP|TCP) \d+\.\d+\.\d+\.\d+:\d+;branch=z9hG4bK[0-9a-f]+;rport\r\n/);
    assert.match(text, /Call-ID: [0-9a-f]{16}@sip\.example\.com\r\n/);
    assert.match(text, /User-Agent: (Linphone|Zoiper|MicroSIP|Bria|PortSIP)[^\r\n]*\r\n/);
    assert.match(text, /CSeq: \d+ REGISTER\r\n/);
    assert.ok(text.endsWith('Content-Length: 0\r\n\r\n'));
});

// === generateProfile ===

test('generateProfile: 5 fields, profile-specific formats', () => {
    const r = mimicry.generateProfile({ profile: 'tls', domain: 'test.example.com' });
    assert.deepEqual(Object.keys(r).sort(), ['i1', 'i2', 'i3', 'i4', 'i5']);
    assert.ok(r.i1.startsWith('<b 0x16'), 'TLS I1 is a TLS record');
    const sip = mimicry.generateProfile({ profile: 'sip', domain: 'sip.test.com' });
    assert.equal(hexOf(sip.i1).toString('ascii').slice(0, 8), 'REGISTER');
    const quic = mimicry.generateProfile({ profile: 'quic', domain: 'quic.test.com' });
    assert.equal(hexOf(quic.i1).length, 1200);
    assert.ok(r.i1 !== r.i2 && r.i2 !== r.i3, 'I-values differ (random generation)');
});

test('generateProfile tls: explicit domain wins, region pools respected', () => {
    const explicit = mimicry.generateProfile({ profile: 'tls', domain: 'my.front.example', region: 'world' });
    assert.equal(parseSNI(parseClientHello(hexOf(explicit.i1))), 'my.front.example');
    for (let i = 0; i < 5; i++) {
        const ru = mimicry.generateProfile({ profile: 'tls', region: 'ru' });
        const sni = parseSNI(parseClientHello(hexOf(ru.i1)));
        assert.ok(mimicry.TLS_DOMAINS_RU.includes(sni), `RU pool contains ${sni}`);
        const world = mimicry.generateProfile({ profile: 'tls', region: 'world' });
        const sniW = parseSNI(parseClientHello(hexOf(world.i1)));
        assert.ok(mimicry.TLS_DOMAINS_WORLD.includes(sniW), `WORLD pool contains ${sniW}`);
    }
});

test('generateProfile: unknown profile falls back to dns', () => {
    const r = mimicry.generateProfile({ profile: 'bogus' });
    assert.match(r.i1, /^<r \d+><b 0x[0-9a-f]+>$/, 'dns format fallback');
});

// === per-I генерация ===

// DNS-вопрос в пакете: encoded name в hex (для 'icloud.com' → 0769636c6f756403636f6d00)
const dnsNameHex = (name) => name.split('.')
    .map((l) => Buffer.from([l.length]).toString('hex') + Buffer.from(l).toString('hex'))
    .join('') + '00';

test('generateProfile perI: each I its own profile, missing fall back to global', () => {
    const r = mimicry.generateProfile({
        profile: 'dns', perI: { 1: 'quic', 2: 'dns', 3: 'sip' },
        dnsSites: ['icloud.com'], rMin: 2, rMax: 40,
    });
    assert.equal(hexOf(r.i1).length, 1200, 'I1 QUIC Initial');
    assert.match(r.i2, /^<r \d+><b 0x[0-9a-f]+>$/, 'I2 full DNS format (per-I dns)');
    assert.ok(dnsHexOf(r.i2).toString('hex').includes(dnsNameHex('icloud.com')), 'I2 DNS question from dnsSites');
    assert.equal(hexOf(r.i3).toString('ascii').slice(0, 8), 'REGISTER', 'I3 SIP');
    assert.match(r.i4, /^<r \d+><b 0x[0-9a-f]+>$/, 'I4 falls back to global dns');
    assert.match(r.i5, /^<r \d+><b 0x[0-9a-f]+>$/, 'I5 falls back to global dns');
});

test('generateProfile perI: dnsMimicAll ignored — per-I dns always full DNS format', () => {
    const r = mimicry.generateProfile({
        profile: 'dns', perI: { 2: 'dns' }, dnsMimicAll: false,
        dnsSites: ['icloud.com'], rMin: 2, rMax: 40,
    });
    assert.match(r.i2, /^<r \d+><b 0x[0-9a-f]+>$/, 'not the junk <b 0xHEX><r N> variant');
    assert.ok(!/^<b 0x[0-9a-f]{32}><r \d+>$/.test(r.i2), 'full DNS format even without dnsMimicAll');
});

test('generateProfile perI: onlyI1 empties I2-I5 in per-I mode too', () => {
    const r = mimicry.generateProfile({ profile: 'dns', perI: { 2: 'sip' }, onlyI1: true });
    assert.notEqual(r.i1, '');
    assert.equal(r.i2, '');
    assert.equal(r.i3, '');
    assert.equal(r.i4, '');
    assert.equal(r.i5, '');
});

test('generateProfile perI: explicit domain wins for per-I dns', () => {
    const r = mimicry.generateProfile({
        profile: 'dns', perI: { 2: 'dns' }, domain: 'custom.example', rMin: 2, rMax: 40,
    });
    assert.ok(dnsHexOf(r.i2).toString('hex').includes(dnsNameHex('custom.example')),
        'per-I dns uses explicit MIMICRY_DOMAIN');
});

test('generateProfile defaultDomain: yandex used for tls/quic/sip, explicit domain beats it', () => {
    const tls = mimicry.generateProfile({ profile: 'tls', defaultDomain: 'yandex.ru', onlyI1: true });
    assert.equal(parseSNI(parseClientHello(hexOf(tls.i1))), 'yandex.ru');
    const quic = mimicry.generateProfile({ profile: 'quic', defaultDomain: 'yandex.com' });
    assert.equal(hexOf(quic.i1).length, 1200);
    const sip = mimicry.generateProfile({ profile: 'sip', defaultDomain: 'yandex.ru', onlyI1: true });
    assert.ok(hexOf(sip.i1).toString('ascii').startsWith('REGISTER sip:yandex.ru SIP/2.0'));
    const explicit = mimicry.generateProfile({ profile: 'tls', defaultDomain: 'yandex.ru', domain: 'my.front.example', onlyI1: true });
    assert.equal(parseSNI(parseClientHello(hexOf(explicit.i1))), 'my.front.example');
});

test('generateProfile defaultDomain: per-I dns ignores it (pool question)', () => {
    const r = mimicry.generateProfile({
        profile: 'dns', perI: { 2: 'dns' }, defaultDomain: 'yandex.ru',
        dnsSites: ['icloud.com'], rMin: 2, rMax: 40,
    });
    assert.ok(dnsHexOf(r.i2).toString('hex').includes(dnsNameHex('icloud.com')), 'question from dnsSites, not yandex');
});
