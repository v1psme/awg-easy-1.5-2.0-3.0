'use strict';

// === CPS mimicry generators (dns / tls / quic / sip) ===
// Ported from pumbaX/awg-multi-script (MIT, tmp/awg-multi-script/awg2.sh):
// gen_tls_clienthello, gen_quic_initial/second/short, gen_sip, helpers.
// DNS profile: the project's own proven DNS-response format (moved from config.js).
// Firefox/Safari TLS fingerprints: own implementation from public protocol facts
// (RFC 8701 GREASE, NSS/Apple SecureTransport cipher orders, JA3/JA4 databases).
// Pure module: no env reads — all options come in as arguments.

const crypto = require('crypto');

// === Helpers ===
const rh = (n) => crypto.randomBytes(n);
const ri = (a, b) => {
    if (a > b) [a, b] = [b, a];
    return a + crypto.randomInt(b - a + 1);
};
const rc = (lst) => lst[crypto.randomInt(lst.length)];
const concat = (...bufs) => Buffer.concat(bufs);
const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v & 0xFFFF);
    return b;
};
const u24 = (v) => Buffer.from([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);
const toCps = (raw) => '<b 0x' + raw.toString('hex') + '>';
const secureShuffle = (lst) => {
    for (let i = lst.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [lst[i], lst[j]] = [lst[j], lst[i]];
    }
    return lst;
};

const randPrivateIP = () => {
    const kind = crypto.randomInt(3);
    if (kind === 0) return `10.${ri(1, 254)}.${ri(0, 255)}.${ri(2, 254)}`;
    if (kind === 1) return `172.${ri(16, 31)}.${ri(0, 255)}.${ri(2, 254)}`;
    return `192.168.${ri(0, 255)}.${ri(2, 254)}`;
};

// GREASE values (RFC 8701)
const GREASE_VALUES = [
    0x0A0A, 0x1A1A, 0x2A2A, 0x3A3A, 0x4A4A, 0x5A5A, 0x6A6A, 0x7A7A,
    0x8A8A, 0x9A9A, 0xAAAA, 0xBABA, 0xCACA, 0xDADA, 0xEAEA, 0xFAFA,
];
const grease = (excluded) => {
    const pool = GREASE_VALUES.filter((v) => v !== excluded);
    return rc(pool.length ? pool : GREASE_VALUES);
};

const ext = (etype, data) => concat(u16(etype), u16(data.length), data);

// === Domain pools (data, from awg2.sh L283-352, adapted) ===
const TLS_DOMAINS_WORLD = [
    'google.com', 'github.com', 'gitlab.com', 'stackoverflow.com',
    'microsoft.com', 'apple.com', 'amazon.com',
    'mozilla.org', 'kernel.org', 'debian.org', 'ubuntu.com',
    'cdn.jsdelivr.net', 'unpkg.com', 'pypi.org',
    'hetzner.com', 'ovhcloud.com', 'digitalocean.com',
    'steampowered.com', 'spotify.com',
];
const TLS_DOMAINS_RU = TLS_DOMAINS_WORLD.concat([
    'ya.ru', 'vk.com', 'mail.ru', 'ozon.ru', 'wildberries.ru',
    'rutube.ru', 'gosuslugi.ru',
]);
const SIP_DOMAINS = [
    'sip.zadarma.com', 'sip.iptel.org', 'sip.linphone.org', 'sip.antisip.com',
    'sip.dus.net', 'sip.easybell.de',
    'sip.voys.nl', 'sip.peoplefone.ch', 'sip.messagenet.it',
];
const QUIC_DOMAINS_WORLD = [
    'google.com', 'youtube.com',
    'cdn.jsdelivr.net', 'unpkg.com',
    'icloud.com', 'mzstatic.com',
    'fastly.net', 'a.ssl.fastly.net',
    'b-cdn.net',
    'github.com', 'objects.githubusercontent.com',
];
const QUIC_DOMAINS_RU = QUIC_DOMAINS_WORLD.concat(['ozon.ru']);
// DNS world pool matches the historical I1_DNS_SITES default exactly
const DNS_DOMAINS_WORLD = ['icloud.com', 'google.com', 'nvidia.com'];
const DNS_DOMAINS_RU = DNS_DOMAINS_WORLD.concat(['ya.ru', 'vk.com', 'mail.ru']);

const domainPool = (profile, region) => {
    switch (profile) {
    case 'tls': return region === 'ru' ? TLS_DOMAINS_RU : TLS_DOMAINS_WORLD;
    case 'quic': return region === 'ru' ? QUIC_DOMAINS_RU : QUIC_DOMAINS_WORLD;
    case 'sip': return SIP_DOMAINS;
    case 'dns': return region === 'ru' ? DNS_DOMAINS_RU : DNS_DOMAINS_WORLD;
    default: return DNS_DOMAINS_WORLD;
    }
};

// === DNS packet (project's proven response format, moved from config.js) ===
const encodeDNSName = (name) => {
    const parts = name.split('.');
    const labels = parts.map((p) => concat(Buffer.from([p.length]), Buffer.from(p)));
    return concat(...labels, Buffer.from([0]));
};

const generateRandomIP = () => {
    const octets = Array.from({ length: 4 }, () => Math.floor(Math.random() * 223) + 1);
    return octets.join('.');
};

const buildDNSMimic = (domain, ip, opts = {}) => {
    const ipOctets = ip.split('.').map(Number);
    const txid = crypto.randomBytes(2);
    const encodedName = encodeDNSName(domain);
    const header = concat(txid, Buffer.from('0001000100000000', 'hex'));
    const question = concat(encodedName, Buffer.from('00010001', 'hex'));
    const answer = concat(
        Buffer.from('c00c000100010000105a0004', 'hex'),
        Buffer.from(ipOctets)
    );
    const rMin = opts.rMin || 2;
    const rMax = opts.rMax || 40;
    // По состоянию на 10.08.2026: r > 40 ломает handshake
    const rLen = rMin + crypto.randomInt(rMax - rMin + 1);
    const payload = concat(header, question, answer).toString('hex');
    return `<r ${rLen}><b 0x${payload}>`;
};

// === TLS 1.3 ClientHello (Chrome-like; ported from pumbaX payloadGen) ===
const CHROME_CIPHERS = [
    0x1301, 0x1302, 0x1303, 0xC02B, 0xC02F, 0xC02C, 0xC030,
    0xCCA9, 0xCCA8, 0xC013, 0xC014, 0x009C, 0x009D, 0x002F, 0x0035,
];
const CHROME_SIGALGS = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601];

const buildChromeHello = (host) => {
    const g1 = grease();
    const g2 = grease(g1);

    const ciphers = concat(u16(g1), ...CHROME_CIPHERS.map((c) => u16(c)));

    let exts = concat();
    exts = concat(exts, ext(g1, Buffer.alloc(0)));                       // grease
    exts = concat(exts, ext(0x0000, concat(u16(concat(Buffer.from([0]), u16(host.length), host).length),
        Buffer.from([0]), u16(host.length), host)));                     // sni
    exts = concat(exts, ext(0x0017, Buffer.alloc(0)));                   // extended_master_secret
    exts = concat(exts, ext(0xFF01, Buffer.from([0])));                  // renegotiation_info
    const groups = concat(u16(grease()), u16(0x001D), u16(0x0017), u16(0x0018));
    exts = concat(exts, ext(0x000A, concat(u16(groups.length), groups)));// supported_groups
    exts = concat(exts, ext(0x000B, Buffer.from([1, 0])));               // ec_point_formats
    exts = concat(exts, ext(0x0023, Buffer.alloc(0)));                   // session_ticket
    const alpn = Buffer.from('\x02h2\x08http/1.1', 'binary');
    exts = concat(exts, ext(0x0010, concat(u16(alpn.length), alpn)));    // alpn
    exts = concat(exts, ext(0x0005, Buffer.from([1, 0, 0, 0, 0])));      // status_request
    const sigs = concat(...CHROME_SIGALGS.map((s) => u16(s)));
    exts = concat(exts, ext(0x000D, concat(u16(sigs.length), sigs)));    // signature_algorithms
    exts = concat(exts, ext(0x0012, Buffer.alloc(0)));                   // signed_certificate_timestamp
    const sv = concat(u16(grease()), u16(0x0304), u16(0x0303));
    exts = concat(exts, ext(0x002B, concat(Buffer.from([sv.length]), sv))); // supported_versions
    const ksList = concat(u16(grease()), u16(0), u16(0x001D), u16(32), rh(32));
    exts = concat(exts, ext(0x0033, concat(u16(ksList.length), ksList)));   // key_share
    exts = concat(exts, ext(0x002D, Buffer.from([1, 1])));               // psk_key_exchange_modes
    exts = concat(exts, ext(0x001B, Buffer.from([2, 0, 2])));            // compress_certificate
    exts = concat(exts, ext(0x4469, Buffer.from('\x03\x02h2', 'binary'))); // ALPS
    exts = concat(exts, ext(g2, Buffer.alloc(0)));                       // secondary grease
    // Light padding like real Chrome (0-48). No 512-fill: ~200 zero bytes per
    // packet broke delivery on mobile AWG (especially I5) — awg2.sh lesson.
    const padLen = ri(0, 48);
    if (padLen > 0) exts = concat(exts, ext(0x0015, Buffer.alloc(padLen)));

    const body = concat(
        u16(0x0303), rh(32), Buffer.concat([Buffer.from([32]), rh(32)]),
        u16(ciphers.length), ciphers,
        Buffer.from([1, 0]),
        u16(exts.length), exts
    );
    const hs = concat(Buffer.from([0x01]), u24(body.length), body);
    return concat(Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs);
};

// === Firefox-shaped ClientHello (NSS, Firefox 120+; own implementation) ===
const FIREFOX_CIPHERS = [
    0x1301, 0x1302, 0x1303,
    0xC02B, 0xC02C, 0xC02F, 0xC030,
    0xCCA9, 0xCCA8,
    0xC008, 0xC009, 0xC00A,
    0xC013, 0xC014, 0xC012,
    0x009C, 0x009D, 0x002F, 0x0035, 0x000A,
];
const FIREFOX_SIGALGS = [0x0403, 0x0503, 0x0604, 0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0201, 0x0203];
const FIREFOX_DC_ALGS = [0x0403, 0x0503, 0x0604, 0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0201];

const buildFirefoxHello = (host) => {
    const ciphers = concat(...FIREFOX_CIPHERS.map((c) => u16(c)));
    const buildExts = (withPadding, padLen) => {
        let exts = concat();
        exts = concat(exts, ext(0x0000, concat(u16(concat(Buffer.from([0]), u16(host.length), host).length),
            Buffer.from([0]), u16(host.length), host)));                 // sni
        exts = concat(exts, ext(0x0017, Buffer.alloc(0)));               // extended_master_secret
        exts = concat(exts, ext(0xFF01, Buffer.from([0])));              // renegotiation_info
        const groups = concat(u16(0x001D), u16(0x0017), u16(0x0018));
        exts = concat(exts, ext(0x000A, concat(u16(groups.length), groups)));
        exts = concat(exts, ext(0x000B, Buffer.from([1, 0])));           // ec_point_formats
        exts = concat(exts, ext(0x0023, Buffer.alloc(0)));               // session_ticket
        const alpn = Buffer.from('\x02h2\x08http/1.1', 'binary');
        exts = concat(exts, ext(0x0010, concat(u16(alpn.length), alpn)));// alpn
        exts = concat(exts, ext(0x0005, Buffer.from([1, 0, 0, 0, 0])));  // status_request
        const dc = concat(...FIREFOX_DC_ALGS.map((a) => u16(a)));
        exts = concat(exts, ext(0x0022, concat(u16(dc.length), dc)));    // delegated_credentials
        const ksEntry = concat(u16(0x001D), u16(32), rh(32));
        exts = concat(exts, ext(0x0033, concat(u16(ksEntry.length), ksEntry))); // key_share
        const sv = concat(u16(0x0304), u16(0x0303));
        exts = concat(exts, ext(0x002B, concat(Buffer.from([sv.length]), sv))); // supported_versions
        const sigs = concat(...FIREFOX_SIGALGS.map((s) => u16(s)));
        exts = concat(exts, ext(0x000D, concat(u16(sigs.length), sigs))); // signature_algorithms
        exts = concat(exts, ext(0x002D, Buffer.from([1, 1])));           // psk_key_exchange_modes
        exts = concat(exts, ext(0x0012, Buffer.alloc(0)));               // signed_certificate_timestamp
        if (withPadding) exts = concat(exts, ext(0x0015, Buffer.alloc(padLen))); // padding
        return exts;
    };
    const wrap = (extsBuf) => {
        const body = concat(
            u16(0x0303), rh(32), Buffer.concat([Buffer.from([32]), rh(32)]),
            u16(ciphers.length), ciphers,
            Buffer.from([1, 0]),
            u16(extsBuf.length), extsBuf
        );
        const hs = concat(Buffer.from([0x01]), u24(body.length), body);
        return concat(Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs);
    };
    // Firefox pads the whole ClientHello record to 512 bytes.
    const bare = wrap(buildExts(false, 0));
    const pad = 512 - (bare.length + 4);
    if (pad < 0) return bare;
    return wrap(buildExts(true, pad));
};

// === Safari-shaped ClientHello (Apple SecureTransport, Safari 16; own implementation) ===
const SAFARI_CIPHERS = [
    0x1301, 0x1302, 0x1303,
    0xC02C, 0xC02B, 0xC030, 0xC02F,
    0xCCA9, 0xCCA8,
    0xC024, 0xC023, 0xC00A, 0xC009, 0xC008,
    0xC028, 0xC027,
    0xC014, 0xC013, 0xC012,
    0x009D, 0x009C, 0x003D, 0x003C,
    0x0035, 0x002F, 0x00FF,
];
const SAFARI_SIGALGS = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601, 0x0201];

const buildSafariHello = (host) => {
    const ciphers = concat(...SAFARI_CIPHERS.map((c) => u16(c)));
    let exts = concat();
    exts = concat(exts, ext(0x0000, concat(u16(concat(Buffer.from([0]), u16(host.length), host).length),
        Buffer.from([0]), u16(host.length), host)));                     // sni
    exts = concat(exts, ext(0x000B, Buffer.from([1, 0])));               // ec_point_formats
    exts = concat(exts, ext(0x0017, Buffer.alloc(0)));                   // extended_master_secret
    exts = concat(exts, ext(0xFF01, Buffer.from([0])));                  // renegotiation_info
    const groups = concat(u16(0x001D), u16(0x0017), u16(0x0018), u16(0x0019));
    exts = concat(exts, ext(0x000A, concat(u16(groups.length), groups))); // supported_groups
    exts = concat(exts, ext(0x0023, Buffer.alloc(0)));                   // session_ticket
    exts = concat(exts, ext(0x0005, Buffer.from([1, 0, 0, 0, 0])));      // status_request
    const sigs = concat(...SAFARI_SIGALGS.map((s) => u16(s)));
    exts = concat(exts, ext(0x000D, concat(u16(sigs.length), sigs)));    // signature_algorithms
    const sv = concat(u16(0x0304), u16(0x0303), u16(0x0302));
    exts = concat(exts, ext(0x002B, concat(Buffer.from([sv.length]), sv))); // supported_versions (incl TLS 1.1)
    exts = concat(exts, ext(0x002D, Buffer.from([1, 1])));               // psk_key_exchange_modes
    const ksEntries = concat(
        u16(0x001D), u16(32), rh(32),                                    // x25519
        u16(0x0017), u16(65), Buffer.concat([Buffer.from([4]), rh(64)])  // secp256r1
    );
    exts = concat(exts, ext(0x0033, concat(u16(ksEntries.length), ksEntries))); // key_share
    const alpn = Buffer.from('\x02h2\x08http/1.1', 'binary');
    exts = concat(exts, ext(0x0010, concat(u16(alpn.length), alpn)));    // alpn
    exts = concat(exts, ext(0x0012, Buffer.alloc(0)));                   // signed_certificate_timestamp

    const body = concat(
        u16(0x0303), rh(32), Buffer.concat([Buffer.from([32]), rh(32)]),
        u16(ciphers.length), ciphers,
        Buffer.from([1, 0]),
        u16(exts.length), exts
    );
    const hs = concat(Buffer.from([0x01]), u24(body.length), body);
    return concat(Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs);
};

const genTlsClientHello = (domain, browser = 'chrome') => {
    const host = Buffer.from(domain || 'google.com');
    switch (browser) {
    case 'firefox': return buildFirefoxHello(host);
    case 'safari': return buildSafariHello(host);
    default: return buildChromeHello(host);
    }
};

// === QUIC (RFC 9000/9001; ported from pumbaX, incl. real Initial encryption) ===
const QUIC_VERSION = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const QUIC_INITIAL_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');

const quicVarint = (v) => {
    if (v < 64) return Buffer.from([v]);
    if (v < 16384) {
        const b = Buffer.alloc(2);
        b.writeUInt16BE((v | 0x4000) & 0xFFFF);
        return b;
    }
    if (v < 1073741824) {
        const b = Buffer.alloc(4);
        b.writeUInt32BE((v | 0x80000000) >>> 0);
        return b;
    }
    const b = Buffer.alloc(8);
    b.writeUInt32BE(Math.floor(v / 4294967296) | 0xC0000000);
    b.writeUInt32BE(v >>> 0, 4);
    return b;
};

const quicCryptoFrame = (ch) => concat(
    Buffer.from([0x06]), quicVarint(0), quicVarint(ch.length), ch
);

// HKDF (RFC 5869) expand-only, as QUIC's HKDF-Expand-Label needs it.
const hkdfExtract = (salt, ikm) => crypto.createHmac('sha256', salt).update(ikm).digest();
const hkdfExpand = (prk, info, length) => {
    const out = [];
    let t = Buffer.alloc(0);
    let i = 1;
    while (Buffer.concat(out).length < length) {
        t = crypto.createHmac('sha256', prk).update(concat(t, info, Buffer.from([i]))).digest();
        out.push(t);
        i++;
    }
    return concat(...out).subarray(0, length);
};
const hkdfExpandLabel = (secret, label, length) => {
    const full = Buffer.from('tls13 ' + label);
    const info = concat(u16(length), Buffer.from([full.length]), full, Buffer.from([0]));
    return hkdfExpand(secret, info, length);
};

// Real QUIC Initial protection (RFC 9001). Returns protected packet or null
// on any failure — caller falls back to the masked (plain) variant, which is
// equally valid for CPS (the kernel treats I-values as opaque bytes).
const tryQuicEncrypt = (dcid, headerWoPn, pn, pnLen, payload) => {
    try {
        const initialSecret = hkdfExtract(QUIC_INITIAL_SALT, dcid);
        const clientSecret = hkdfExpandLabel(initialSecret, 'client in', 32);
        const key = hkdfExpandLabel(clientSecret, 'quic key', 16);
        const iv = hkdfExpandLabel(clientSecret, 'quic iv', 12);
        const hp = hkdfExpandLabel(clientSecret, 'quic hp', 16);

        const pnInt = pn.readUIntBE(0, pnLen);
        const pnFull = Buffer.alloc(12);
        pnFull.writeUIntBE(pnInt, 12 - pnLen, pnLen);
        const nonce = Buffer.from(iv.map((b, i) => b ^ pnFull[i]));

        const aad = concat(headerWoPn, pn);
        const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
        cipher.setAAD(aad);
        const ct = concat(cipher.update(payload), cipher.final(), cipher.getAuthTag());

        const sample = ct.subarray(Math.max(4 - pnLen, 0), 4 - pnLen + 16);
        const enc = crypto.createCipheriv('aes-128-ecb', hp, null);
        enc.setAutoPadding(false);
        const mask = enc.update(sample);

        const first = headerWoPn[0] ^ (mask[0] & 0x0F);
        const protPn = Buffer.from(pn.map((b, i) => b ^ mask[1 + i]));
        return concat(Buffer.from([first]), headerWoPn.subarray(1), protPn, ct);
    } catch {
        return null;
    }
};

const genQuicInitial = (domain, browser = 'chrome') => {
    const TARGET = 1200;
    const ch = genTlsClientHello(domain, browser);
    const cryptoFrame = quicCryptoFrame(ch);
    const dcid = rh(8);
    const scid = rh(8);
    const pnLen = 4;
    const pn = rh(pnLen);
    const pre = concat(
        Buffer.from([0xC0 | (pnLen - 1)]), QUIC_VERSION,
        Buffer.from([8]), dcid, Buffer.from([8]), scid, Buffer.from([0])
    );
    const overhead = pre.length + 2 + pnLen + 16; // +2 varint length, +16 AEAD tag
    let pad = TARGET - overhead - cryptoFrame.length;
    if (pad < 0) pad = 0;
    const payload = concat(cryptoFrame, Buffer.alloc(pad));
    const lengthField = pnLen + payload.length + 16;
    const headerWoPn = concat(pre, u16(0x4000 | lengthField));
    const enc = tryQuicEncrypt(dcid, headerWoPn, pn, pnLen, payload);
    let pkt = enc !== null ? enc : concat(headerWoPn, pn, payload);
    // Fill to the QUIC minimum with RANDOM bytes: a real Initial payload is
    // AEAD-encrypted, a zero run would be a fingerprint no client produces.
    if (pkt.length < TARGET) pkt = concat(pkt, rh(TARGET - pkt.length));
    else if (pkt.length > TARGET) pkt = pkt.subarray(0, TARGET);
    return { packet: pkt, dcid, version: QUIC_VERSION };
};

const genQuicSecondInitial = (dcid, version) => {
    const fb = rc([0xC0, 0xC0, 0xC3]);
    const pnLen = (fb & 0x03) + 1;
    const scid = rh(8);
    const target = ri(300, 600);
    let encSize = target - 26 - pnLen;
    if (encSize < 1) encSize = 1;
    const plenVal = pnLen + encSize;
    const plVarint = u16(0x4000 | plenVal);
    const pn = rh(pnLen);
    const payload = rh(encSize);
    let pkt = concat(
        Buffer.from([fb]), version,
        Buffer.from([8]), dcid, Buffer.from([8]), scid, Buffer.from([0]),
        plVarint, pn, payload
    );
    if (pkt.length !== target) {
        pkt = pkt.length > target ? pkt.subarray(0, target) : concat(pkt, rh(target - pkt.length));
    }
    return pkt;
};

const genQuicShort = () => {
    const pnLen = ri(1, 4);
    const spin = ri(0, 1) << 5;
    const key = ri(0, 1) << 2;
    const fb = 0x40 | spin | key | (pnLen - 1);
    return concat(Buffer.from([fb]), rh(8), rh(pnLen), rh(ri(40, 90)));
};

// === SIP REGISTER (ported from pumbaX) ===
const SIP_UA_POOL = [
    'Linphone/5.2.5 (belle-sip/5.2.0)', 'Zoiper rv2.10.20.4',
    'MicroSIP/3.21.4', 'Bria 6.5.1', 'PortSIP UA 16.4',
];
const SIP_USER_POOL = ['alice', 'bob', '100', '200', 'sip', 'user', 'client'];

const genSip = (domain) => {
    const host = domain || rc(SIP_DOMAINS);
    const user = rc(SIP_USER_POOL) + ri(10, 9999);
    const lip = randPrivateIP();
    const lport = rc([5060, 5062, 5080, 5160, ri(10000, 65000)]);
    const branch = 'z9hG4bK' + rh(7).toString('hex');
    const tag = rh(4).toString('hex');
    const callid = `${rh(8).toString('hex')}@${host}`;
    const cseq = ri(1, 50);
    const transport = rc(['udp', 'udp', 'udp', 'udp', 'tcp']);
    const ua = rc(SIP_UA_POOL);
    const lines = [
        `REGISTER sip:${host} SIP/2.0`,
        `Via: SIP/2.0/${transport.toUpperCase()} ${lip}:${lport};branch=${branch};rport`,
        'Max-Forwards: 70',
        `From: <sip:${user}@${host}>;tag=${tag}`,
        `To: <sip:${user}@${host}>`,
        `Call-ID: ${callid}`,
        `CSeq: ${cseq} REGISTER`,
        `Contact: <sip:${user}@${lip}:${lport};transport=${transport}>`,
        `User-Agent: ${ua}`,
        'Allow: INVITE, ACK, CANCEL, BYE, REFER, OPTIONS, NOTIFY, SUBSCRIBE, PRACK, MESSAGE, INFO, UPDATE',
        'Supported: replaces, outbound, gruu, path',
        `Expires: ${rc([300, 600, 1800, 3600])}`,
        'Content-Length: 0', '', '',
    ];
    return Buffer.from(lines.join('\r\n'), 'ascii');
};

// === Profile dispatch ===
// Returns {i1..i5}: CPS strings in the project's conf format. Empty strings
// are omitted from the .conf by the template (project convention).
const generateProfile = (opts = {}) => {
    const profile = opts.profile || 'dns';
    const browser = opts.browser || 'chrome';
    const region = opts.region || 'world';
    const explicitDomain = opts.domain || '';
    const onlyI1 = !!opts.onlyI1;
    const dnsSites = (opts.dnsSites && opts.dnsSites.length)
        ? opts.dnsSites : DNS_DOMAINS_WORLD;
    const dnsMimicAll = !!opts.dnsMimicAll;
    const rMin = opts.rMin || 2;
    const rMax = opts.rMax || 40;
    const empty = { i1: '', i2: '', i3: '', i4: '', i5: '' };

    switch (profile) {
    case 'tls': {
        const pool = domainPool('tls', region);
        const host = explicitDomain || rc(pool);
        const i1 = toCps(genTlsClientHello(host, browser));
        if (onlyI1) return { ...empty, i1 };
        const mk = () => toCps(genTlsClientHello(rc(pool), browser));
        return { i1, i2: mk(), i3: mk(), i4: mk(), i5: mk() };
    }
    case 'dns': {
        const dnsPkt = (d) => buildDNSMimic(d, generateRandomIP(), { rMin, rMax });
        const i1 = dnsPkt(explicitDomain || rc(dnsSites));
        if (onlyI1) return { ...empty, i1 };
        const junk = () => `<b 0x${rh(16).toString('hex')}><r ${rMin + crypto.randomInt(rMax - rMin + 1)}>`;
        const mk = () => (dnsMimicAll ? dnsPkt(rc(dnsSites)) : junk());
        return { i1, i2: mk(), i3: mk(), i4: mk(), i5: mk() };
    }
    case 'sip': {
        const host = explicitDomain || rc(SIP_DOMAINS);
        const i1 = toCps(genSip(host));
        if (onlyI1) return { ...empty, i1 };
        // All five on the same domain (profile convention)
        return { i1, i2: toCps(genSip(host)), i3: toCps(genSip(host)), i4: toCps(genSip(host)), i5: toCps(genSip(host)) };
    }
    case 'quic': {
        const pool = domainPool('quic', region);
        const host = explicitDomain || rc(pool);
        const init = genQuicInitial(host, browser);
        const i1 = toCps(init.packet);
        if (onlyI1) return { ...empty, i1 };
        return {
            i1,
            i2: toCps(genQuicSecondInitial(init.dcid, init.version)),
            i3: toCps(genQuicShort()),
            i4: toCps(genQuicShort()),
            i5: toCps(genQuicShort()),
        };
    }
    default:
        // unknown profile → dns (same fallback as the port source)
        return generateProfile({ ...opts, profile: 'dns' });
    }
};

module.exports = {
    generateProfile,
    genTlsClientHello,
    genQuicInitial,
    genQuicSecondInitial,
    genQuicShort,
    genSip,
    buildDNSMimic,
    encodeDNSName,
    generateRandomIP,
    domainPool,
    secureShuffle,
    toCps,
    GREASE_VALUES,
    TLS_DOMAINS_WORLD,
    TLS_DOMAINS_RU,
    SIP_DOMAINS,
    QUIC_DOMAINS_WORLD,
    QUIC_DOMAINS_RU,
    DNS_DOMAINS_WORLD,
    DNS_DOMAINS_RU,
    // Test hooks (crypto core validation against RFC 9001 vectors)
    tryQuicEncrypt,
    hkdfExtract,
    hkdfExpandLabel,
    QUIC_INITIAL_SALT,
};
