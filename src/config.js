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

// === Мимикрия CPS (dns|tls|quic|sip): генераторы в lib/mimicry.js ===
const mimicry = require('./lib/mimicry');

// Сайты для dns-профиля (историческая переменная I1_DNS_SITES)
const DNS_SITES = (process.env.I1_DNS_SITES || 'icloud.com,google.com,nvidia.com').split(',').map(s => s.trim()).filter(Boolean);
module.exports.DNS_SITES = DNS_SITES;

const MIMICRY_PROFILES = ['dns', 'tls', 'quic', 'sip'];
const MIMICRY_BROWSERS = ['chrome', 'firefox', 'safari'];
// QUIC/TLS — только для I1, всегда: I2-I5 ограничены dns|sip
const MIMICRY_I1_PROFILES = MIMICRY_PROFILES;
const MIMICRY_I2_5_PROFILES = ['dns', 'sip'];

/**
 * Разрешить mimicry env в план генерации. Чистая функция: env передаётся
 * аргументом (для тестов), process.env не читает.
 * Правила:
 *  - MIMICRY_PROFILE_I1..I5 — per-I профили; I1: dns|tls|quic|sip,
 *    I2-I5: только dns|sip (tls/quic/unknown → clamp к dns + warning)
 *  - глобальный MIMICRY_PROFILE=tls|quic → I1 = tls/quic, I2-I5 = dns
 *  - MIMICRY_BROWSER_I1 — браузер I1 (fallback: MIMICRY_BROWSER)
 *  - MIMICRY_DOMAIN не задан → defaultDomain: yandex.ru (region=ru) / yandex.com
 * @param {Record<string, string|undefined>} env
 * @returns {{profile:string, browser:string, browserI1:string, domain:string,
 *            region:string, onlyI1:boolean, defaultDomain:string,
 *            perI: {1..5:string}|undefined, warnings:string[]}}
 */
const resolveMimicryPlan = (env = {}) => {
    const warnings = [];
    const norm = (v) => (v === undefined || v === null) ? '' : String(v).toLowerCase().trim();
    const region = norm(env.MIMICRY_REGION) === 'ru' ? 'ru' : 'world';
    const defaultDomain = region === 'ru' ? 'yandex.ru' : 'yandex.com';

    let profile = norm(env.MIMICRY_PROFILE) || 'dns';
    if (!MIMICRY_PROFILES.includes(profile)) {
        warnings.push(`MIMICRY_PROFILE: unknown profile '${profile}', fallback to 'dns'`);
        profile = 'dns';
    }
    let browser = norm(env.MIMICRY_BROWSER) || 'chrome';
    if (!MIMICRY_BROWSERS.includes(browser)) {
        warnings.push(`MIMICRY_BROWSER: unknown browser '${browser}', fallback to 'chrome'`);
        browser = 'chrome';
    }
    // Браузер I1: MIMICRY_BROWSER_I1 бьёт глобальный (валиден только он: I1 — единственный,
    // где допустимы tls/quic)
    let browserI1 = browser;
    if (norm(env.MIMICRY_BROWSER_I1) !== '') {
        if (MIMICRY_BROWSERS.includes(norm(env.MIMICRY_BROWSER_I1))) {
            browserI1 = norm(env.MIMICRY_BROWSER_I1);
        } else {
            warnings.push(`MIMICRY_BROWSER_I1: unknown browser '${norm(env.MIMICRY_BROWSER_I1)}', fallback to '${browser}'`);
        }
    }
    const domain = norm(env.MIMICRY_DOMAIN);
    const onlyI1 = env.MIMICRY_ONLY_I1 === 'true';

    // per-I профили: явные значения ('' = не задан)
    const perIExplicit = {};
    let perIActive = false;
    for (let i = 1; i <= 5; i++) {
        const raw = norm(env[`MIMICRY_PROFILE_I${i}`]);
        if (raw === '') { perIExplicit[i] = ''; continue; }
        perIActive = true;
        if (i === 1) {
            if (MIMICRY_I1_PROFILES.includes(raw)) {
                perIExplicit[i] = raw;
            } else {
                warnings.push(`MIMICRY_PROFILE_I1: unknown profile '${raw}', fallback to 'dns'`);
                perIExplicit[i] = 'dns';
            }
        } else if (MIMICRY_I2_5_PROFILES.includes(raw)) {
            perIExplicit[i] = raw;
        } else {
            warnings.push(`MIMICRY_PROFILE_I${i}: '${raw}' not allowed for I2-I5 (dns|sip only, QUIC/TLS are I1-only) — clamped to 'dns'`);
            perIExplicit[i] = 'dns';
        }
    }

    // Итоговая карта генерации: per-I явное > глобальный профиль;
    // глобальный tls/quic даёт I2-I5 = dns (QUIC/TLS — только для I1)
    const resolvedIndex = (i) => {
        if (perIExplicit[i] !== '') return perIExplicit[i];
        if (i >= 2 && (profile === 'tls' || profile === 'quic')) return 'dns';
        return profile;
    };
    const perI = (perIActive || profile === 'tls' || profile === 'quic')
        ? { 1: resolvedIndex(1), 2: resolvedIndex(2), 3: resolvedIndex(3), 4: resolvedIndex(4), 5: resolvedIndex(5) }
        : undefined;

    return { profile, browser, browserI1, domain, region, onlyI1, defaultDomain, perI, warnings };
};
module.exports.resolveMimicryPlan = resolveMimicryPlan;

const _mimicryPlan = resolveMimicryPlan(process.env);
for (const w of _mimicryPlan.warnings) {
    // eslint-disable-next-line no-console
    console.warn(w);
}
module.exports.MIMICRY_PROFILE = _mimicryPlan.profile;
module.exports.MIMICRY_BROWSER = _mimicryPlan.browser;
module.exports.MIMICRY_BROWSER_I1 = _mimicryPlan.browserI1;
module.exports.MIMICRY_DOMAIN = _mimicryPlan.domain;
module.exports.MIMICRY_REGION = _mimicryPlan.region;
module.exports.MIMICRY_ONLY_I1 = _mimicryPlan.onlyI1;
module.exports.MIMICRY_DEFAULT_DOMAIN = _mimicryPlan.defaultDomain;
module.exports.MIMICRY_PLAN = _mimicryPlan;
// === Конец блока мимикрии ===

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

    // I1-I5: профиль мимикрии из resolveMimicryPlan (глобальный + per-I).
    // Явные I1..I5 в env всегда побеждают (''/'0'/'null' = отключено).
    const normI = (val) => (val === '' || val === '0' || val === 'null') ? '' : val;
    const envI = (n) => (process.env[n] !== undefined) ? normI(process.env[n]) : undefined;

    const rMin = parseInt(process.env.I_R_MIN, 10) || 2;
    const rMax = parseInt(process.env.I_R_MAX, 10) || 40;
    // По состоянию на 10.08.2026: r > 40 ломает handshake
    module.exports.I_R_MIN = rMin;
    module.exports.I_R_MAX = rMax;
    const dnsMimicAll = process.env.I_DNS_MIMIC_ALL === 'true';

    // I_DNS_MIMIC_ALL = alias dns-профиля (I2-I5 тоже в DNS-формате);
    // работает только в legacy-пути dns-профиля (под perI игнорируется).
    const generated = mimicry.generateProfile({
        profile: _mimicryPlan.profile,
        perI: _mimicryPlan.perI,
        browser: _mimicryPlan.browserI1,
        domain: _mimicryPlan.domain,
        defaultDomain: _mimicryPlan.defaultDomain,
        region: _mimicryPlan.region,
        onlyI1: _mimicryPlan.onlyI1,
        dnsSites: DNS_SITES,
        dnsMimicAll,
        rMin,
        rMax,
    });
    module.exports.I1 = envI('I1') !== undefined ? envI('I1') : generated.i1;
    module.exports.I2 = envI('I2') !== undefined ? envI('I2') : generated.i2;
    module.exports.I3 = envI('I3') !== undefined ? envI('I3') : generated.i3;
    module.exports.I4 = envI('I4') !== undefined ? envI('I4') : generated.i4;
    module.exports.I5 = envI('I5') !== undefined ? envI('I5') : generated.i5;

    // AWG 3.0: Header Protection + таймеры
    if (isAwg3()) {
        // Поднять S3/S4 минимумы до 12 (требование HeaderProtectionKey)
        module.exports.S3 = process.env.S3 || getRandomInt(12, 55);
        module.exports.S4 = process.env.S4 || getRandomInt(12, 27);

        // Header protection key: включён по умолчанию для v3
        // (HEADER_PROTECTION_KEY_ENABLE=false — выключить)
        // Сам ключ: только из env (44-char base64); если не задан —
        // генерируется ОДИН раз в WireGuard.js и сохраняется в persisted config.
        // Не генерировать здесь: randomBytes при каждом старте = ротация ключа
        // при каждом рестарте контейнера (ломает всех клиентов).
        module.exports.HEADER_PROTECTION_KEY_ENABLE = process.env.HEADER_PROTECTION_KEY_ENABLE !== 'false';
        module.exports.HEADER_PROTECTION_KEY = process.env.HEADER_PROTECTION_KEY || '';

        // Таймеры и padding: env-пин ("N"/"LO-HI") или рандомная генерация
        // по протокольным дефолтам Amnezia 3.0 (lib/awg3-timers.js).
        // "(off)" → '' (поле убирается = протокольный дефолт; парсеры
        // amneziawg "(off)" не поддерживают). Невалидный пин → warn + рандом.
        const awg3Timers = require('./lib/awg3-timers');
        const generatedTimers = awg3Timers.generateAwg3Timers();
        const timerFromEnv = (envKey, generated) => {
            const raw = process.env[envKey];
            if (raw === undefined || raw === '') return generated;
            const v = awg3Timers.normalizeU16Range(raw);
            if (v !== null) return v;
            // eslint-disable-next-line no-console
            console.warn(`${envKey}: invalid value '${raw}' (expected "N", "LO-HI" or "(off)") — using generated ${generated}`);
            return generated;
        };
        module.exports.CONTENT_PADDING_ADDITION = timerFromEnv('CONTENT_PADDING_ADDITION', generatedTimers.contentPaddingAddition);
        module.exports.REKEY_AFTER_TIME = timerFromEnv('REKEY_AFTER_TIME', generatedTimers.rekeyAfterTime);
        module.exports.REKEY_TIMEOUT = timerFromEnv('REKEY_TIMEOUT', generatedTimers.rekeyTimeout);
        module.exports.REJECT_AFTER_TIME = timerFromEnv('REJECT_AFTER_TIME', generatedTimers.rejectAfterTime);
        module.exports.KEEPALIVE_TIMEOUT = timerFromEnv('KEEPALIVE_TIMEOUT', generatedTimers.keepaliveTimeout);
        module.exports.MAX_HANDSHAKE_ATTEMPTS = timerFromEnv('MAX_HANDSHAKE_ATTEMPTS', generatedTimers.maxHandshakeAttempts);

        // Инвариант RejectAfterTime > RekeyAfterTime: для сгенерированных значений
        // гарантирован генератором; для явных пинов — только предупреждение.
        if (process.env.REJECT_AFTER_TIME !== undefined && process.env.REKEY_AFTER_TIME !== undefined) {
            const loOf = (s) => Number(String(s).split('-')[0]);
            const rekeyHi = Number(String(module.exports.REKEY_AFTER_TIME).split('-')[1]);
            if (Number.isFinite(loOf(module.exports.REJECT_AFTER_TIME)) && Number.isFinite(rekeyHi)
                && loOf(module.exports.REJECT_AFTER_TIME) <= rekeyHi) {
                // eslint-disable-next-line no-console
                console.warn('REJECT_AFTER_TIME <= REKEY_AFTER_TIME — session will be rejected before rekey (Amnezia invariant violated by env pins)');
            }
        }
    }
}