'use strict';

const crypto = require('crypto');
const { release: { version } } = require('./package.json');

// === Вспомогательные функции ===
const getRandomInt = (min, max) => min + Math.floor(Math.random() * (max - min));
const getRandomJunkSize = () => getRandomInt(15, 150);

const getRandomHex = (bytes = 64) => crypto.randomBytes(bytes).toString('hex');

const generateAmneziaSignature = () => {
    const randomHex = getRandomHex();
    const rValue = getRandomInt(2, 5);
    return `<r ${rValue}><b 0x${randomHex}>`;
};

// === Динамический DNS-mimic генератор ===
const DNS_SITES = (process.env.I1_DNS_SITES || 'icloud.com,google.com,nvidia.com').split(',').map(s => s.trim()).filter(Boolean);
const DNS_NSLOOKUP = process.env.I1_DNS_NSLOOKUP === 'true';

const encodeDNSName = (name) => {
    const parts = name.split('.');
    const labels = parts.map(p => {
        const len = Buffer.from([p.length]);
        return Buffer.concat([len, Buffer.from(p)]);
    });
    return Buffer.concat([...labels, Buffer.from([0])]);
};

const generateRandomIP = () => {
    const octets = Array.from({length: 4}, () => Math.floor(Math.random() * 223) + 1);
    return octets.join('.');
};

const buildDNSMimic = (domain, ip) => {
    const ipOctets = ip.split('.').map(Number);
    const txid = require('crypto').randomBytes(2);
    const encodedName = encodeDNSName(domain);
    const header = Buffer.concat([txid, Buffer.from('0001000100000000', 'hex')]);
    const question = Buffer.concat([encodedName, Buffer.from('00010001', 'hex')]);
    const answer = Buffer.concat([
        Buffer.from('c00c000100010000105a0004', 'hex'),
        Buffer.from(ipOctets)
    ]);
    const rMin = parseInt(process.env.I_R_MIN, 10) || 2;
    const rMax = parseInt(process.env.I_R_MAX, 10) || 40;
    // По состоянию на 10.08.2026: r > 40 ломает handshake
    const rLen = rMin + Math.floor(Math.random() * (rMax - rMin + 1));
    const payload = Buffer.concat([header, question, answer]).toString('hex');
    return `<r ${rLen}><b 0x${payload}>`;
};

const generateDNSMimic = () => {
    const domain = DNS_SITES[Math.floor(Math.random() * DNS_SITES.length)];
    const ip = generateRandomIP();
    return buildDNSMimic(domain, ip);
};

// Async DNS resolution: call after server starts to update I1 with real IPs
const initDNSMimic = async () => {
    if (!DNS_NSLOOKUP) return;
    const { resolve4 } = require('dns').promises;
    for (let i = 0; i < DNS_SITES.length; i++) {
        try {
            const addrs = await resolve4(DNS_SITES[i]);
            if (addrs[0]) {
                // Cache one real IP, done
                const cachedIP = addrs[0];
                const cachedDomain = DNS_SITES[i];
                const origGenerate = generateDNSMimic;
                // Override for subsequent calls to prefer real IPs
                module.exports.__getCachedDNS = () => ({ domain: cachedDomain, ip: cachedIP });
                break;
            }
        } catch {}
    }
};
// === Конец DNS-mimic генератора ===

// AMNEZIA_VERSION: выбор версии обфускации (1.5, 2, 3)
const AMNEZIA_VERSION = (() => {
    const v = process.env.AMNEZIA_VERSION;
    if (v === '2' || v === '2.0') return '2';
    if (v === '3' || v === '3.0') return '3';
    // Обратная совместимость
    if (process.env.AMNEZIAWG_ENABLED === 'true') {
        // eslint-disable-next-line no-console
        console.warn('AMNEZIAWG_ENABLED is deprecated, use AMNEZIA_VERSION=2');
        return '2';
    }
    return '1.5';
})();

const isAwg2Plus = () => AMNEZIA_VERSION === '2' || AMNEZIA_VERSION === '3';
const isAwg3 = () => AMNEZIA_VERSION === '3';

const getIValue = (envVar, generatorFunc) => {
    const val = process.env[envVar];
    if (val === undefined || val === '' || val === '0' || val === 'null') return undefined;
    if (val !== undefined) return val;
    return generatorFunc();
};

// === Генерация непересекающихся диапазонов с зазором ===
// Возвращает массив из n строк вида "min-max"
function generateNonOverlappingRanges(n, globalMin, globalMax, minGap = 1, maxGap = 500) {
    const minRangeLen = 1000; // минимальная длина каждого диапазона
    const totalRange = globalMax - globalMin;
    const requiredSpace = n * minRangeLen + (n - 1) * minGap;

    // Если места не хватает — используем упрощённый метод (делим на равные части и рандомизируем)
    if (totalRange < requiredSpace) {
        console.warn('Not enough space for ranges with gaps, using simplified method');
        const step = (globalMax - globalMin) / n;
        const ranges = [];
        for (let i = 0; i < n; i++) {
            let min = Math.floor(globalMin + i * step);
            let max = Math.floor(globalMin + (i + 1) * step);
            if (min >= max) max = min + 1;
            const shift = getRandomInt(-step / 4, step / 4);
            min = Math.max(globalMin, min + shift);
            max = Math.min(globalMax, max + shift);
            if (min >= max) max = min + 1;
            ranges.push(`${min}-${max}`);
        }
        return ranges;
    }

    const ranges = [];
    let currentPos = globalMin;
    for (let i = 0; i < n; i++) {
        const remaining = n - i - 1;
        // Максимально возможный min с учётом оставшихся диапазонов
        const maxPossibleMin = globalMax - remaining * (minRangeLen + maxGap) - minRangeLen;
        let min = getRandomInt(currentPos, maxPossibleMin + 1);
        if (min < currentPos) min = currentPos;
        // Максимально возможный max
        let maxPossible = globalMax - remaining * (minRangeLen + maxGap);
        if (maxPossible < min + minRangeLen) maxPossible = min + minRangeLen;
        let max = getRandomInt(min + minRangeLen, maxPossible + 1);
        if (max > globalMax) max = globalMax;
        ranges.push(`${min}-${max}`);
        // Случайный зазор перед следующим диапазоном
        const gap = getRandomInt(minGap, maxGap + 1);
        currentPos = max + gap;
    }
    return ranges;
}

// H1-H4: per Amnezia docs — 0 to 4,294,967,295 (uint32)
const H_GLOBAL_MIN = 5;
const H_GLOBAL_MAX = 4294967295;

// Равномерно распределяем 4 диапазона по всему uint32 пространству
const generateSpreadRanges = (n, globalMin, globalMax) => {
    const regionSize = Math.floor((globalMax - globalMin) / n);
    const ranges = [];
    for (let i = 0; i < n; i++) {
        const regionStart = globalMin + i * regionSize;
        const regionEnd = (i < n - 1) ? globalMin + (i + 1) * regionSize : globalMax;
        // Random range within this region (10%-80% of region)
        const rangeWidth = Math.floor(regionSize * (0.1 + Math.random() * 0.7));
        const rangeMin = regionStart + Math.floor(Math.random() * (regionSize - rangeWidth));
        const rangeMax = rangeMin + rangeWidth;
        ranges.push(`${rangeMin}-${rangeMax}`);
    }
    return ranges;
};

const generatedRanges = generateSpreadRanges(4, H_GLOBAL_MIN, H_GLOBAL_MAX);
const [H1_DEF, H2_DEF, H3_DEF, H4_DEF] = generatedRanges;

// Одиночные значения для AWG 1.0 (не диапазоны)
const generateSingleH = () => Math.floor(Math.random() * (H_GLOBAL_MAX - H_GLOBAL_MIN)) + H_GLOBAL_MIN;
const H1_SINGLE = generateSingleH();
const H2_SINGLE = generateSingleH();
const H3_SINGLE = generateSingleH();
const H4_SINGLE = generateSingleH();

// === Экспорт переменных окружения ===
module.exports.RELEASE = version;
module.exports.WEB_PATH = process.env.WEB_PATH || '';
module.exports.REDIRECT_ROOT = process.env.REDIRECT_ROOT !== 'false';
module.exports.ADMIN_LOGIN = process.env.ADMIN_LOGIN || '';
module.exports.PORT = process.env.PORT || '51821';
module.exports.WEBUI_HOST = process.env.WEBUI_HOST || '0.0.0.0';
module.exports.PASSWORD_HASH = process.env.PASSWORD_HASH;
module.exports.PASSWORD = process.env.PASSWORD;
module.exports.AMNEZIA_VERSION = AMNEZIA_VERSION;
module.exports.SERVICE_NAME = process.env.SERVICE_NAME || 'RenNetline';
module.exports.MAX_AGE = parseInt(process.env.MAX_AGE, 10) * 1000 * 60 || 0;
module.exports.WG_PATH = process.env.WG_PATH || '/etc/amnezia/amneziawg/';
module.exports.WG_DEVICE = process.env.WG_DEVICE || 'eth0';
module.exports.WG_HOST = process.env.WG_HOST;
module.exports.WG_PORT = process.env.WG_PORT || '51820';
module.exports.WG_CONFIG_PORT = process.env.WG_CONFIG_PORT || process.env.WG_PORT || '51820';
module.exports.WG_MTU = process.env.WG_MTU || '1280';
module.exports.WG_PERSISTENT_KEEPALIVE = process.env.WG_PERSISTENT_KEEPALIVE || '25';
module.exports.WG_DEFAULT_ADDRESS = process.env.WG_DEFAULT_ADDRESS || '10.8.0.x';
module.exports.WG_DEFAULT_DNS = typeof process.env.WG_DEFAULT_DNS === 'string'
  ? process.env.WG_DEFAULT_DNS
  : '1.1.1.1';
module.exports.WG_DNS_ROUTING_ENABLED = process.env.WG_DNS_ROUTING_ENABLED || 'false';
module.exports.WG_DNS_ROUTING_UPSTREAMS = process.env.WG_DNS_ROUTING_UPSTREAMS || module.exports.WG_DEFAULT_DNS;
module.exports.WG_ALLOWED_IPS = process.env.WG_ALLOWED_IPS || '0.0.0.0/0, ::/0';
module.exports.WG_UPLINK_ENABLED = process.env.WG_UPLINK_ENABLED || 'false';
module.exports.WG_UPLINK_INTERFACE = process.env.WG_UPLINK_INTERFACE || '';
module.exports.WG_UPLINK_CONFIG_PATH = process.env.WG_UPLINK_CONFIG_PATH || '';
module.exports.WG_UPLINK_CONFIGS_PATH = process.env.WG_UPLINK_CONFIGS_PATH || '/etc/wireguard/uplinks';
module.exports.WG_UPLINK_TABLE = Math.max(1, parseInt(process.env.WG_UPLINK_TABLE, 10) || 200);
module.exports.WG_UPLINK_SOURCE_RULES = process.env.WG_UPLINK_SOURCE_RULES || '';

module.exports.WG_PRE_UP = process.env.WG_PRE_UP || '';
module.exports.WG_POST_UP = process.env.WG_POST_UP || `
iptables -t nat -A POSTROUTING -s ${module.exports.WG_DEFAULT_ADDRESS.replace('x', '0')}/24 -o ${module.exports.WG_DEVICE} -j MASQUERADE;
iptables -A INPUT -p udp -m udp --dport ${module.exports.WG_PORT} -j ACCEPT;
iptables -A FORWARD -i awg0 -j ACCEPT;
iptables -A FORWARD -o awg0 -j ACCEPT;
`.split('\n').join(' ');

module.exports.WG_PRE_DOWN = process.env.WG_PRE_DOWN || '';
module.exports.WG_POST_DOWN = process.env.WG_POST_DOWN || `
iptables -t nat -D POSTROUTING -s ${module.exports.WG_DEFAULT_ADDRESS.replace('x', '0')}/24 -o ${module.exports.WG_DEVICE} -j MASQUERADE;
iptables -D INPUT -p udp -m udp --dport ${module.exports.WG_PORT} -j ACCEPT;
iptables -D FORWARD -i awg0 -j ACCEPT;
iptables -D FORWARD -o awg0 -j ACCEPT;
`.split('\n').join(' ');

module.exports.LANG = process.env.LANG || 'en';
module.exports.UI_TRAFFIC_STATS = process.env.UI_TRAFFIC_STATS || 'false';
module.exports.UI_CHART_TYPE = process.env.UI_CHART_TYPE || 0;
module.exports.WG_ENABLE_ONE_TIME_LINKS = process.env.WG_ENABLE_ONE_TIME_LINKS || 'false';
module.exports.UI_ENABLE_SORT_CLIENTS = process.env.UI_ENABLE_SORT_CLIENTS || 'false';
module.exports.WG_ENABLE_EXPIRES_TIME = process.env.WG_ENABLE_EXPIRES_TIME || 'false';
module.exports.TELEGRAM_BOT_ENABLED = process.env.TELEGRAM_BOT_ENABLED || 'false';
module.exports.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
module.exports.TELEGRAM_ADMIN_IDS = process.env.TELEGRAM_ADMIN_IDS || '';
module.exports.TELEGRAM_BOT_POLL_TIMEOUT_SECONDS = Math.max(1, parseInt(process.env.TELEGRAM_BOT_POLL_TIMEOUT_SECONDS, 10) || 25);
module.exports.ENABLE_PROMETHEUS_METRICS = process.env.ENABLE_PROMETHEUS_METRICS || 'false';
module.exports.PROMETHEUS_METRICS_PASSWORD = process.env.PROMETHEUS_METRICS_PASSWORD
  || process.env.PROMETHEUS_METRICS_PASSWORD_PLAIN;
module.exports.PROMETHEUS_METRICS_PASSWORD_HASH = process.env.PROMETHEUS_METRICS_PASSWORD_HASH
  || process.env.PROMETHEUS_METRICS_PASSWORD_BCRYPT;
module.exports.TRAFFIC_HISTORY_ENABLED = process.env.TRAFFIC_HISTORY_ENABLED || 'false';
module.exports.TRAFFIC_SAMPLE_INTERVAL_SECONDS = Math.max(1, parseInt(process.env.TRAFFIC_SAMPLE_INTERVAL_SECONDS, 10) || 1);
module.exports.TRAFFIC_RAW_RETENTION_HOURS = Math.max(1, parseInt(process.env.TRAFFIC_RAW_RETENTION_HOURS, 10) || 24);
module.exports.TRAFFIC_MINUTE_RETENTION_DAYS = Math.max(1, parseInt(process.env.TRAFFIC_MINUTE_RETENTION_DAYS, 10) || 90);
module.exports.TRAFFIC_HOUR_RETENTION_DAYS = Math.max(1, parseInt(process.env.TRAFFIC_HOUR_RETENTION_DAYS, 10) || 365);

if (module.exports.PASSWORD_HASH && module.exports.PASSWORD) {
  console.warn('Both PASSWORD_HASH and PASSWORD are set; either value can be used for login.');
}
if (process.env.PROMETHEUS_METRICS_PASSWORD_PLAIN) {
  console.warn('PROMETHEUS_METRICS_PASSWORD_PLAIN is deprecated, use PROMETHEUS_METRICS_PASSWORD.');
}
if (process.env.PROMETHEUS_METRICS_PASSWORD_BCRYPT) {
  console.warn('PROMETHEUS_METRICS_PASSWORD_BCRYPT is deprecated, use PROMETHEUS_METRICS_PASSWORD_HASH.');
}
if (module.exports.PROMETHEUS_METRICS_PASSWORD && module.exports.PROMETHEUS_METRICS_PASSWORD_HASH) {
  console.warn('Both PROMETHEUS_METRICS_PASSWORD and PROMETHEUS_METRICS_PASSWORD_HASH are set; either value can be used for metrics auth.');
}

module.exports.DICEBEAR_TYPE = process.env.DICEBEAR_TYPE || false;
module.exports.USE_GRAVATAR = process.env.USE_GRAVATAR || false;

// GeoIP + GeoSite bypass
module.exports.WG_BYPASS_ENABLED = process.env.WG_BYPASS_ENABLED === 'true';
module.exports.WG_BYPASS_GEOIP = process.env.WG_BYPASS_GEOIP || '';
module.exports.WG_BYPASS_GEOSITE = process.env.WG_BYPASS_GEOSITE || '';
module.exports.WG_BYPASS_DOMAINS = process.env.WG_BYPASS_DOMAINS || '';
module.exports.GEOSITE_DATA_PATH = process.env.GEOSITE_DATA_PATH || '/app/bypass/geosite-data';
module.exports.GEOSITE_GIT_REPO = process.env.GEOSITE_GIT_REPO || 'https://github.com/v2fly/domain-list-community.git';

module.exports.SSL_ENABLED = process.env.SSL_ENABLED === 'true';
const defaultSslCertPath = '/etc/ssl/certs/ssl-cert.pem';
const defaultSslKeyPath = '/etc/ssl/private/ssl-key.pem';
const rawSslCertPath = process.env.SSL_CERT_PATH;
const rawSslKeyPath = process.env.SSL_KEY_PATH;
if (typeof rawSslCertPath === 'string' && rawSslCertPath !== rawSslCertPath.trim()) {
  console.warn('SSL_CERT_PATH has leading/trailing spaces; using trimmed value.');
}
if (typeof rawSslKeyPath === 'string' && rawSslKeyPath !== rawSslKeyPath.trim()) {
  console.warn('SSL_KEY_PATH has leading/trailing spaces; using trimmed value.');
}
module.exports.SSL_CERT_PATH = (rawSslCertPath || defaultSslCertPath).trim();
module.exports.SSL_KEY_PATH = (rawSslKeyPath || defaultSslKeyPath).trim();

// === AmneziaWG параметры (mobile preset based) ===
// https://github.com/bivlked/amneziawg-installer
// Mobile preset: Jc=3 fixed, Jmin=30-50, Jmax=Jmin+20 to Jmin+80
let jminVal, jmaxVal;
const jminRaw = process.env.JMIN;
const jmaxRaw = process.env.JMAX;
if (jminRaw !== undefined && jminRaw !== '') {
    jminVal = parseInt(jminRaw, 10);
} else {
    jminVal = getRandomInt(35, 50);
}
if (jmaxRaw !== undefined && jmaxRaw !== '') {
    jmaxVal = parseInt(jmaxRaw, 10);
} else {
    jmaxVal = jminVal + getRandomInt(20, 60);
}
module.exports.JC = process.env.JC || 3;                    // mobile preset: fixed 3
module.exports.JMIN = jminVal;
module.exports.JMAX = jmaxVal;
// S1: init padding, S2: response padding. Constraint: S1 + 56 ≠ S2
let s1val, s2val;
s1val = process.env.S1 ? parseInt(process.env.S1, 10) : getRandomJunkSize();
s2val = process.env.S2 ? parseInt(process.env.S2, 10) : getRandomJunkSize();
if (s1val + 56 === s2val) s2val = s1val + 57; // enforce S1+56 ≠ S2
module.exports.S1 = s1val;
module.exports.S2 = s2val;

// H1-H4: non-overlapping ranges (AWG 2.0) или одиночные значения (AWG 1.0)
// Per Amnezia docs: 0-4,294,967,295, must not overlap
if (isAwg2Plus()) {
    module.exports.H1 = (process.env.H1 && process.env.H1 !== '') ? process.env.H1 : H1_DEF;
    module.exports.H2 = (process.env.H2 && process.env.H2 !== '') ? process.env.H2 : H2_DEF;
    module.exports.H3 = (process.env.H3 && process.env.H3 !== '') ? process.env.H3 : H3_DEF;
    module.exports.H4 = (process.env.H4 && process.env.H4 !== '') ? process.env.H4 : H4_DEF;
} else {
    module.exports.H1 = (process.env.H1 && process.env.H1 !== '') ? process.env.H1 : H1_SINGLE;
    module.exports.H2 = (process.env.H2 && process.env.H2 !== '') ? process.env.H2 : H2_SINGLE;
    module.exports.H3 = (process.env.H3 && process.env.H3 !== '') ? process.env.H3 : H3_SINGLE;
    module.exports.H4 = (process.env.H4 && process.env.H4 !== '') ? process.env.H4 : H4_SINGLE;
}

// AWG 2.0 параметры — полная поддержка CPS I1-I5
if (isAwg2Plus()) {
    // S3: cookie padding (8-55), S4: data padding (4-27)
    module.exports.S3 = process.env.S3 || getRandomInt(8, 55);
    module.exports.S4 = process.env.S4 || getRandomInt(4, 27);

    // I1: DNS-mimic по умолчанию (маскировка под DNS-ответ)
    // Формат: <r 2><b 0xTXID+DNS_PAYLOAD>
    module.exports.I1 = (process.env.I1 !== undefined) ? (process.env.I1 || '') : generateDNSMimic();

    // I2-I5: <b 0xHEX><r N> (без <rc>), или DNS-mimic если I_DNS_MIMIC_ALL=true
    const rMin = parseInt(process.env.I_R_MIN, 10) || 2;
    const rMax = parseInt(process.env.I_R_MAX, 10) || 40;
    // По состоянию на 10.08.2026: r > 40 ломает handshake
    const randomR = () => rMin + Math.floor(Math.random() * (rMax - rMin + 1));
    const dnsMimicAll = process.env.I_DNS_MIMIC_ALL === 'true';
    const genIx = () => dnsMimicAll ? generateDNSMimic() : ('<b 0x' + require('crypto').randomBytes(16).toString('hex') + '><r ' + randomR() + '>');
    module.exports.I2 = (process.env.I2 !== undefined) ? (process.env.I2 || '') : genIx();
    module.exports.I3 = (process.env.I3 !== undefined) ? (process.env.I3 || '') : genIx();
    module.exports.I4 = (process.env.I4 !== undefined) ? (process.env.I4 || '') : genIx();
    module.exports.I5 = (process.env.I5 !== undefined) ? (process.env.I5 || '') : genIx();

    // Если в env явно задана пустая строка — возвращаем пустую строку
    // (шаблон WireGuard.js отфильтрует пустые значения)
    if (process.env.I2 === '') module.exports.I2 = '';
    if (process.env.I3 === '') module.exports.I3 = '';
    if (process.env.I4 === '') module.exports.I4 = '';
    if (process.env.I5 === '') module.exports.I5 = '';

    // AWG 3.0: Header Protection + таймеры
    if (isAwg3()) {
        // Поднять S3/S4 минимумы до 12 (требование HeaderProtectionKey)
        module.exports.S3 = process.env.S3 || getRandomInt(12, 55);
        module.exports.S4 = process.env.S4 || getRandomInt(12, 27);

        // Header protection key: опциональный, включается через .env
        // (требует поддержки клиентом, по умолчанию выключен)
        if (process.env.HEADER_PROTECTION_KEY_ENABLE === 'true') {
          module.exports.HEADER_PROTECTION_KEY = process.env.HEADER_PROTECTION_KEY
            || require('crypto').randomBytes(32).toString('base64');
        } else {
          module.exports.HEADER_PROTECTION_KEY = '';
        }

        // Таймеры и padding — все в формате диапазона "lo-hi" или "(off)"
        module.exports.CONTENT_PADDING_ADDITION = process.env.CONTENT_PADDING_ADDITION || '16-128';
        module.exports.REKEY_AFTER_TIME = process.env.REKEY_AFTER_TIME || '100-145';
        module.exports.REKEY_TIMEOUT = process.env.REKEY_TIMEOUT || '4-10';
        module.exports.REJECT_AFTER_TIME = process.env.REJECT_AFTER_TIME || '180-200';
        module.exports.KEEPALIVE_TIMEOUT = process.env.KEEPALIVE_TIMEOUT || '8-22';
        module.exports.MAX_HANDSHAKE_ATTEMPTS = process.env.MAX_HANDSHAKE_ATTEMPTS || '12-28';
    }
}