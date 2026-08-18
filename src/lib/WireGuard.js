'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('path');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns').promises;
const debug = require('debug')('WireGuard');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const QRCode = require('qrcode');

const Util = require('./Util');
const ServerError = require('./ServerError');
const TrafficHistory = require('./TrafficHistory');
const ConfigStore = require('./ConfigStore');

const {
  WG_PATH,
  WG_HOST,
  WG_PORT,
  WG_CONFIG_PORT,
  WG_MTU,
  WG_DEFAULT_DNS,
  WG_DEFAULT_ADDRESS,
  WG_DEVICE,
  WG_DNS_ROUTING_ENABLED,
  WG_DNS_ROUTING_UPSTREAMS,
  WG_PERSISTENT_KEEPALIVE,
  WG_ALLOWED_IPS,
  WG_UPLINK_ENABLED,
  WG_UPLINK_INTERFACE,
  WG_UPLINK_CONFIG_PATH,
  WG_UPLINK_CONFIGS_PATH,
  WG_UPLINK_TABLE,
  WG_UPLINK_SOURCE_RULES,
  WG_PRE_UP,
  WG_POST_UP,
  WG_PRE_DOWN,
  WG_POST_DOWN,
  WG_ENABLE_EXPIRES_TIME,
  WG_ENABLE_ONE_TIME_LINKS,
  TRAFFIC_HISTORY_ENABLED,
  TRAFFIC_SAMPLE_INTERVAL_SECONDS,
  TRAFFIC_RAW_RETENTION_HOURS,
  TRAFFIC_MINUTE_RETENTION_DAYS,
  TRAFFIC_HOUR_RETENTION_DAYS,
  JC,
  JMIN,
  JMAX,
  S1,
  S2,
  H1,
  H2,
  H3,
  H4,
  WG_BYPASS_ENABLED,
  WG_BYPASS_GEOIP,
  WG_BYPASS_GEOSITE,
  WG_BYPASS_DOMAINS,
} = require('../config');

const ensureUplinkConfigTableOff = (content) => {
  const normalizedContent = String(content).replace(/\r\n/g, '\n');
  const lines = normalizedContent.split('\n');
  let interfaceStart = -1;
  let interfaceEnd = lines.length;

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (!match) {
      continue;
    }

    if (match[1].trim().toLowerCase() === 'interface') {
      interfaceStart = index;
      continue;
    }

    if (interfaceStart !== -1) {
      interfaceEnd = index;
      break;
    }
  }

  if (interfaceStart === -1) {
    return normalizedContent;
  }

  const interfaceLines = lines.slice(interfaceStart + 1, interfaceEnd);
  const tableLineIndex = interfaceLines.findIndex((line) => /^\s*Table\s*=.*$/i.test(line));

  if (tableLineIndex !== -1) {
    interfaceLines[tableLineIndex] = 'Table = off';
  } else {
    interfaceLines.push('Table = off');
  }

  return [
    ...lines.slice(0, interfaceStart + 1),
    ...interfaceLines,
    ...lines.slice(interfaceEnd),
  ].join('\n');
};

const hasUplinkConfigTableOff = (content) => /^\s*Table\s*=\s*off\s*$/im.test(String(content));

module.exports = class WireGuard {

  constructor() {
    this.__resolvedWgHost = null;
    this.__runtimeSettings = this.__getEnvRuntimeSettings();
    this.__trafficSamplerEnabled = this.__runtimeSettings.trafficHistoryEnabled;
    this.__trafficSamplerStarted = false;
    this.__trafficSamplerTimer = null;
    this.__uplinkRuntime = [];
    this.__dnsRoutingRuntime = null;
    this.__dnsRoutingSyncPromise = Promise.resolve();
    this.__resolveState = {
      running: false,
      total: 0,
      processed: 0,
      startedAt: null,
      eta: null,
      errors: 0,
      lastResolved: null,
    };
    this.__geoSiteCronTimer = null;
    this.__lifecyclePromise = Promise.resolve();
    this.__configInitializingPromise = null;
    this.__configPromise = null;
    this.__configStore = new ConfigStore({
      basePath: WG_PATH,
    });
    this.__trafficHistory = new TrafficHistory({
      basePath: WG_PATH,
      sampleIntervalSeconds: this.__runtimeSettings.trafficSampleIntervalSeconds,
      rawRetentionHours: this.__runtimeSettings.trafficRawRetentionHours,
      minuteRetentionDays: this.__runtimeSettings.trafficMinuteRetentionDays,
      hourRetentionDays: this.__runtimeSettings.trafficHourRetentionDays,
    });
  }

  __getEnvRuntimeSettings() {
    return {
      wgHost: typeof WG_HOST === 'string' ? WG_HOST.trim() : '',
      defaultDns: typeof WG_DEFAULT_DNS === 'string' ? WG_DEFAULT_DNS.trim() : '1.1.1.1',
      wgPort: String(WG_PORT),
      wgConfigPort: String(WG_CONFIG_PORT),
      wgMtu: WG_MTU || '',
      wgDefaultAddress: WG_DEFAULT_ADDRESS,
      wgAllowedIps: WG_ALLOWED_IPS,
      wgPersistentKeepalive: String(WG_PERSISTENT_KEEPALIVE),
      enableExpireTime: WG_ENABLE_EXPIRES_TIME === 'true',
      enableOneTimeLinks: WG_ENABLE_ONE_TIME_LINKS === 'true',
      trafficHistoryEnabled: TRAFFIC_HISTORY_ENABLED === 'true',
      trafficSampleIntervalSeconds: TRAFFIC_SAMPLE_INTERVAL_SECONDS,
      trafficRawRetentionHours: TRAFFIC_RAW_RETENTION_HOURS,
      trafficMinuteRetentionDays: TRAFFIC_MINUTE_RETENTION_DAYS,
      trafficHourRetentionDays: TRAFFIC_HOUR_RETENTION_DAYS,
    };
  }

  __applyRuntimeSettings(settings = {}) {
    const merged = {
      ...this.__getEnvRuntimeSettings(),
      ...(settings || {}),
    };

    merged.wgHost = typeof merged.wgHost === 'string' ? merged.wgHost.trim() : '';
    merged.defaultDns = typeof merged.defaultDns === 'string' ? merged.defaultDns.trim() : '1.1.1.1';
    merged.wgPort = String(merged.wgPort || WG_PORT).trim();
    merged.wgConfigPort = String(merged.wgConfigPort || merged.wgPort || WG_CONFIG_PORT).trim();
    merged.wgMtu = typeof merged.wgMtu === 'string' ? merged.wgMtu.trim() : '';
    merged.wgDefaultAddress = typeof merged.wgDefaultAddress === 'string' && merged.wgDefaultAddress.trim()
      ? merged.wgDefaultAddress.trim()
      : WG_DEFAULT_ADDRESS;
    merged.wgAllowedIps = typeof merged.wgAllowedIps === 'string' && merged.wgAllowedIps.trim()
      ? merged.wgAllowedIps.trim()
      : WG_ALLOWED_IPS;
    merged.wgPersistentKeepalive = String(merged.wgPersistentKeepalive || WG_PERSISTENT_KEEPALIVE).trim();
    merged.enableExpireTime = merged.enableExpireTime === true;
    merged.enableOneTimeLinks = merged.enableOneTimeLinks === true;
    merged.trafficHistoryEnabled = merged.trafficHistoryEnabled === true;
    merged.trafficSampleIntervalSeconds = Math.max(1, parseInt(merged.trafficSampleIntervalSeconds, 10) || TRAFFIC_SAMPLE_INTERVAL_SECONDS);
    merged.trafficRawRetentionHours = Math.max(1, parseInt(merged.trafficRawRetentionHours, 10) || TRAFFIC_RAW_RETENTION_HOURS);
    merged.trafficMinuteRetentionDays = Math.max(1, parseInt(merged.trafficMinuteRetentionDays, 10) || TRAFFIC_MINUTE_RETENTION_DAYS);
    merged.trafficHourRetentionDays = Math.max(1, parseInt(merged.trafficHourRetentionDays, 10) || TRAFFIC_HOUR_RETENTION_DAYS);

    this.__runtimeSettings = merged;
    this.__trafficSamplerEnabled = merged.trafficHistoryEnabled;
    this.__trafficHistory.sampleIntervalSeconds = merged.trafficSampleIntervalSeconds;
    this.__trafficHistory.rawRetentionHours = merged.trafficRawRetentionHours;
    this.__trafficHistory.minuteRetentionDays = merged.trafficMinuteRetentionDays;
    this.__trafficHistory.hourRetentionDays = merged.trafficHourRetentionDays;
  }

  __getRuntimeNetworkCidr(runtime) {
    return `${runtime.wgDefaultAddress.replace('x', '0')}/24`;
  }

  __getRuntimePostUp(runtime) {
    if (process.env.WG_POST_UP) {
      return WG_POST_UP;
    }

    return `
iptables -t nat -A POSTROUTING -s ${this.__getRuntimeNetworkCidr(runtime)} -o ${WG_DEVICE} -j MASQUERADE;
iptables -A INPUT -p udp -m udp --dport ${runtime.wgPort} -j ACCEPT;
iptables -A FORWARD -i wg0 -j ACCEPT;
iptables -A FORWARD -o wg0 -j ACCEPT;
`.split('\n').join(' ');
  }

  __getRuntimePostDown(runtime) {
    if (process.env.WG_POST_DOWN) {
      return WG_POST_DOWN;
    }

    return `
iptables -t nat -D POSTROUTING -s ${this.__getRuntimeNetworkCidr(runtime)} -o ${WG_DEVICE} -j MASQUERADE;
iptables -D INPUT -p udp -m udp --dport ${runtime.wgPort} -j ACCEPT;
iptables -D FORWARD -i wg0 -j ACCEPT;
iptables -D FORWARD -o wg0 -j ACCEPT;
`.split('\n').join(' ');
  }

  async __loadRuntimeSettings() {
    const settings = await this.__getAppSettings();
    this.__applyRuntimeSettings(settings);
    return this.__runtimeSettings;
  }

  __runLifecycleExclusive(fn) {
    const run = this.__lifecyclePromise
      .catch(() => {})
      .then(fn);

    this.__lifecyclePromise = run.catch(() => {});
    return run;
  }

  async __getAppSettings() {
    const settings = await this.__configStore.getAppSettings().catch(() => null);
    return settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};
  }

  async __getConfiguredWgHost() {
    const settings = await this.__loadRuntimeSettings();
    return settings.wgHost;
  }

  async __getConfiguredDefaultDns() {
    const settings = await this.__loadRuntimeSettings();
    return settings.defaultDns;
  }

  async reloadRuntimeSettings() {
    return this.__runLifecycleExclusive(async () => {
      const previousTrafficEnabled = this.__trafficSamplerEnabled;
      await this.__loadRuntimeSettings();
      this.__resolvedWgHost = null;
      if (previousTrafficEnabled && !this.__trafficSamplerEnabled) {
        await this.stopTrafficHistorySampler();
      } else if (!previousTrafficEnabled && this.__trafficSamplerEnabled) {
        await this.startTrafficHistorySampler();
      }
      await this.__resolveWgHost({ required: false });
    });
  }

  async applyRuntimeSettings() {
    return this.__runLifecycleExclusive(async () => {
      const previousTrafficEnabled = this.__trafficSamplerEnabled;
      await this.__loadRuntimeSettings();
      const config = await this.__getConfigUnlocked();
      this.__pruneClientIsolationRules(config);
      this.__normalizeUplinkSettingsList(config);
      this.__normalizeClientUplinkAssignments(config);
      this.__normalizeUplinkProtectedCidrs(config);
      await this.__saveConfig(config);
      await Util.exec('wg-quick down wg0').catch(() => {});
      await Util.exec('wg-quick up wg0').catch((err) => {
        if (err && err.message && err.message.includes('Cannot find device "wg0"')) {
          throw new Error('WireGuard exited with the error: Cannot find device "wg0"\nThis usually means that your host\'s kernel does not support WireGuard!');
        }

        throw err;
      });
      await this.__syncConfig();
      await this.__syncClientIsolationFirewall(config);
      await this.__syncUplinkRouting(config);
      await this.__syncDnsRouting(config);
      this.__configPromise = config;
      this.__resolvedWgHost = null;
      if (previousTrafficEnabled && !this.__trafficSamplerEnabled) {
        await this.stopTrafficHistorySampler();
      } else if (!previousTrafficEnabled && this.__trafficSamplerEnabled) {
        await this.startTrafficHistorySampler();
      }
      await this.__resolveWgHost({ required: false });
      return config;
    });
  }

  __getDefaultClientIsolation() {
    return {
      enabled: false,
      rules: [],
    };
  }

  __getDefaultUplinkSettings(index = 0) {
    const configPath = typeof WG_UPLINK_CONFIG_PATH === 'string' ? WG_UPLINK_CONFIG_PATH.trim() : '';
    const interfaceName = typeof WG_UPLINK_INTERFACE === 'string' ? WG_UPLINK_INTERFACE.trim() : '';

    return {
      id: crypto.randomUUID(),
      name: interfaceName || `Uplink ${index + 1}`,
      enabled: WG_UPLINK_ENABLED === 'true',
      configPath,
      interfaceName,
      table: Math.max(1, parseInt(WG_UPLINK_TABLE, 10) || 200),
      sourceRules: [...new Set(
        String(WG_UPLINK_SOURCE_RULES || '')
          .split(/[\n,;]+/)
          .map((value) => value.trim())
          .filter(Boolean)
      )],
      destinationDomains: [],
    };
  }

  __getEmptyUplinkSettings(index = 0) {
    return {
      id: crypto.randomUUID(),
      name: `Uplink ${index + 1}`,
      enabled: false,
      configPath: '',
      interfaceName: '',
      table: Math.max(1, parseInt(WG_UPLINK_TABLE, 10) || 200),
      sourceRules: [],
      destinationDomains: [],
    };
  }

  __getDefaultDnsRoutingSettings() {
    return {
      enabled: WG_DNS_ROUTING_ENABLED === 'true',
      resolveEnabled: false,
      upstreams: [...new Set(
        String(WG_DNS_ROUTING_UPSTREAMS || WG_DEFAULT_DNS || '')
          .split(/[\s,\n;]+/)
          .map((value) => value.trim())
          .filter(Boolean)
      )],
    };
  }

  __getDefaultRoutingCategory(index = 0) {
    return {
      id: crypto.randomUUID(),
      name: `Category ${index + 1}`,
      enabled: true,
      uplinkId: null,
      domains: [],
    };
  }

  __normalizeRoutingCategories(config) {
    const rawCategories = Array.isArray(config?.routingCategories)
      ? config.routingCategories
      : [];

    config.routingCategories = rawCategories
      .filter((category) => category && typeof category === 'object' && !Array.isArray(category))
      .map((category, index) => {
        const fallback = this.__getDefaultRoutingCategory(index);
        const domains = Array.isArray(category.domains)
          ? category.domains
          : typeof category.domains === 'string'
            ? category.domains.split(/[\n,;]+/)
            : [];

        return {
          id: typeof category.id === 'string' && category.id.trim() ? category.id.trim() : fallback.id,
          name: typeof category.name === 'string' && category.name.trim() ? category.name.trim() : fallback.name,
          enabled: category.enabled !== false,
          uplinkId: typeof category.uplinkId === 'string' && category.uplinkId.trim() ? category.uplinkId.trim() : null,
          domains: [...new Set(
            domains
              .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
              .filter(Boolean)
          )],
        };
      });

    return config.routingCategories;
  }

  __normalizeClientRoutingCategoryAssignments(config) {
    const assignments = config && typeof config.clientRoutingCategories === 'object' && !Array.isArray(config.clientRoutingCategories)
      ? config.clientRoutingCategories
      : {};
    const categories = this.__normalizeRoutingCategories(config);
    const categoryIds = new Set(categories.map((category) => category.id));
    const normalized = {};

    for (const [clientId, categoryIdsValue] of Object.entries(assignments)) {
      if (!config.clients[clientId]) {
        continue;
      }

      const values = Array.isArray(categoryIdsValue)
        ? categoryIdsValue
        : typeof categoryIdsValue === 'string'
          ? categoryIdsValue.split(/[\n,;]+/)
          : [];

      const enabledCategoryIds = [...new Set(
        values
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value && categoryIds.has(value))
      )];

      if (enabledCategoryIds.length > 0) {
        normalized[clientId] = enabledCategoryIds;
      }
    }

    config.clientRoutingCategories = normalized;
    return normalized;
  }

  __validateRoutingCategories(config) {
    const categories = this.__normalizeRoutingCategories(config);
    const uplinks = this.__normalizeUplinkSettingsList(config);
    const uplinkIds = new Set(uplinks.map((uplink) => uplink.id));
    const seenIds = new Set();

    config.routingCategories = categories.filter((category) => {
      if (seenIds.has(category.id)) {
        return false;
      }

      seenIds.add(category.id);
      if (!category.uplinkId || !uplinkIds.has(category.uplinkId)) {
        return false;
      }

      return category.domains.length > 0;
    });

    return config.routingCategories;
  }

  __getEnabledRoutingCategoriesForClient(config, clientId) {
    const assignments = this.__normalizeClientRoutingCategoryAssignments(config);
    const categories = this.__validateRoutingCategories(config);
    const assignedCategoryIds = new Set(assignments[clientId] || []);

    return categories.filter((category) => category.enabled && assignedCategoryIds.has(category.id));
  }

  __getEnabledRoutingCategoriesForUplink(config, uplinkId) {
    const categories = this.__validateRoutingCategories(config);
    const assignments = this.__normalizeClientRoutingCategoryAssignments(config);
    const result = [];

    for (const category of categories) {
      if (!category.enabled || category.uplinkId !== uplinkId) {
        continue;
      }

      const clientIds = Object.entries(assignments)
        .filter(([, categoryIds]) => Array.isArray(categoryIds) && categoryIds.includes(category.id))
        .map(([clientId]) => clientId)
        .filter((clientId) => !!config.clients[clientId]);

      if (clientIds.length === 0) {
        continue;
      }

      result.push({
        ...category,
        clientIds,
      });
    }

    return result;
  }

  __normalizeClientUplinkAssignments(config) {
    const assignments = config && typeof config.clientUplinkAssignments === 'object' && !Array.isArray(config.clientUplinkAssignments)
      ? config.clientUplinkAssignments
      : {};
    const uplinks = this.__normalizeUplinkSettingsList(config);
    const uplinkIds = new Set(uplinks.map((uplink) => uplink.id));
    const normalized = {};

    for (const [clientId, uplinkId] of Object.entries(assignments)) {
      if (!config.clients[clientId]) {
        continue;
      }

      if (typeof uplinkId !== 'string' || !uplinkId.trim()) {
        continue;
      }

      const normalizedUplinkId = uplinkId.trim();
      if (normalizedUplinkId === 'main') {
        normalized[clientId] = 'main';
        continue;
      }

      if (!uplinkIds.has(normalizedUplinkId)) {
        continue;
      }

      normalized[clientId] = normalizedUplinkId;
    }

    config.clientUplinkAssignments = normalized;
    return normalized;
  }

  __getExplicitClientUplinkRuleOverrides(config) {
    const assignments = this.__normalizeClientUplinkAssignments(config);
    const overrides = {};

    for (const [clientId, assignedUplinkId] of Object.entries(assignments)) {
      const client = config.clients[clientId];
      if (!client || !client.address) {
        continue;
      }

      overrides[`${client.address}/32`] = assignedUplinkId;
    }

    return overrides;
  }

  __getAssignedClientSourceRules(config, uplinkId) {
    const assignments = this.__normalizeClientUplinkAssignments(config);
    const sourceRules = [];

    for (const [clientId, assignedUplinkId] of Object.entries(assignments)) {
      if (assignedUplinkId !== uplinkId) {
        continue;
      }

      const client = config.clients[clientId];
      if (!client || !client.address) {
        continue;
      }

      sourceRules.push(`${client.address}/32`);
    }

    return [...new Set(sourceRules)];
  }

  __getEffectiveUplinkSettings(config, uplink) {
    const explicitRuleOverrides = this.__getExplicitClientUplinkRuleOverrides(config);
    const assignedSourceRules = this.__getAssignedClientSourceRules(config, uplink.id);
    const manualSourceRules = (Array.isArray(uplink.sourceRules) ? uplink.sourceRules : [])
      .filter((sourceRule) => explicitRuleOverrides[sourceRule] === undefined);

    return {
      ...uplink,
      sourceRules: [...new Set([
        ...manualSourceRules,
        ...assignedSourceRules,
      ])],
      // manualSourceRules: only user-entered source rules, NOT per-client assignments
      // Used for source-based ip-rule routing (full-tunnel), while the merged
      // sourceRules feeds the source ipset for destination-based (domain/CIDR) filtering
      manualSourceRules: [...manualSourceRules],
    };
  }

  __normalizeSingleUplinkSettings(uplink, fallback, index) {
    const sourceRulesFallback = Array.isArray(fallback?.sourceRules) ? fallback.sourceRules : [];
    const rawSourceRules = Array.isArray(uplink?.sourceRules)
      ? uplink.sourceRules
      : typeof uplink?.sourceRules === 'string'
        ? uplink.sourceRules.split(/[\n,;]+/)
        : sourceRulesFallback;
    const rawDestinationDomains = Array.isArray(uplink?.destinationDomains)
      ? uplink.destinationDomains
      : typeof uplink?.destinationDomains === 'string'
        ? uplink.destinationDomains.split(/[\n,;]+/)
        : [];

    const configPath = typeof uplink?.configPath === 'string' ? uplink.configPath.trim() : fallback.configPath;
    const interfaceFromPath = configPath.endsWith('.conf')
      ? path.posix.basename(configPath, '.conf')
      : '';
    const interfaceName = typeof uplink?.interfaceName === 'string' && uplink.interfaceName.trim()
      ? uplink.interfaceName.trim()
      : (interfaceFromPath || fallback.interfaceName);
    const name = typeof uplink?.name === 'string' && uplink.name.trim()
      ? uplink.name.trim()
      : (interfaceName || fallback.name || `Uplink ${index + 1}`);

    return {
      id: typeof uplink?.id === 'string' && uplink.id.trim() ? uplink.id.trim() : (fallback.id || crypto.randomUUID()),
      name,
      enabled: uplink?.enabled === true,
      configPath,
      interfaceName,
      table: Math.max(1, parseInt(uplink?.table, 10) || fallback.table),
      sourceRules: [...new Set(
        rawSourceRules
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean)
      )],
      geoSiteSync: uplink?.geoSiteSync === true,
      geoIpSync: uplink?.geoIpSync === true,
      destinationIps: [...new Set(
        (Array.isArray(uplink?.destinationIps) ? uplink.destinationIps
          : typeof uplink?.destinationIps === 'string'
            ? uplink.destinationIps.split(/[\n,;]+/) : [])
          .map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
      )],
      destinationDomains: [...new Set(
        rawDestinationDomains
          .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
          .filter(Boolean)
      )],
    };
  }

  __normalizeUplinkSettingsList(config) {
    const hasStoredUplinks = Array.isArray(config?.uplinks);
    const hasLegacyStoredUplink = config && typeof config.uplink === 'object' && !Array.isArray(config.uplink);
    const fallback = hasStoredUplinks || hasLegacyStoredUplink
      ? this.__getEmptyUplinkSettings()
      : this.__getDefaultUplinkSettings();
    const rawUplinks = hasStoredUplinks
      ? config.uplinks
      : (hasLegacyStoredUplink
        ? [config.uplink]
        : [fallback]);

    config.uplinks = rawUplinks
      .filter((uplink) => uplink && typeof uplink === 'object' && !Array.isArray(uplink))
      .map((uplink, index) => this.__normalizeSingleUplinkSettings(uplink, index === 0 ? fallback : this.__getDefaultUplinkSettings(index), index));

    if (config.uplinks.length === 0) {
      config.uplink = hasStoredUplinks || hasLegacyStoredUplink
        ? this.__getEmptyUplinkSettings()
        : this.__getDefaultUplinkSettings();
      return config.uplinks;
    }

    config.uplink = { ...config.uplinks[0] };
    return config.uplinks;
  }

  __normalizeUplinkSettings(config) {
    const uplinks = this.__normalizeUplinkSettingsList(config);
    return uplinks[0] || config.uplink || this.__getEmptyUplinkSettings();
  }

  __normalizeDnsRoutingSettings(config) {
    const defaults = this.__getDefaultDnsRoutingSettings();
    const raw = config && typeof config.dnsRouting === 'object' && !Array.isArray(config.dnsRouting)
      ? config.dnsRouting
      : defaults;

    config.dnsRouting = {
      enabled: raw.enabled === true,
      resolveEnabled: raw.resolveEnabled === true,
      upstreams: [...new Set(
        (Array.isArray(raw.upstreams) ? raw.upstreams : typeof raw.upstreams === 'string' ? raw.upstreams.split(/[\s,\n;]+/) : defaults.upstreams)
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean)
      )],
    };

    if (config.dnsRouting.upstreams.length === 0) {
      config.dnsRouting.upstreams = [...defaults.upstreams];
    }

    return config.dnsRouting;
  }

  __normalizeUplinkProtectedCidrs(config) {
    const raw = Array.isArray(config?.uplinkProtectedCidrs)
      ? config.uplinkProtectedCidrs
      : typeof config?.uplinkProtectedCidrs === 'string'
        ? config.uplinkProtectedCidrs.split(/[\n,;]+/)
        : [];

    config.uplinkProtectedCidrs = [...new Set(
      raw
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .map((value) => {
          try {
            return this.__parseIpv4Cidr(value, { defaultPrefix: 32 }).canonical;
          } catch (err) {
            throw new ServerError(`Invalid protected CIDR: ${value}`, 400);
          }
        })
    )];

    return config.uplinkProtectedCidrs;
  }

  __normalizeAclGroupName(groupName) {
    if (typeof groupName !== 'string') {
      return '';
    }

    const normalizedGroupName = groupName.trim();
    if (!normalizedGroupName) {
      return '';
    }

    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(normalizedGroupName)) {
      throw new ServerError(`Invalid ACL group: ${groupName}`, 400);
    }

    return normalizedGroupName;
  }

  __normalizeClientAclGroups(client) {
    const rawGroups = Array.isArray(client.aclGroups)
      ? client.aclGroups
      : typeof client.aclGroups === 'string'
        ? client.aclGroups.split(/[,\n;]+/)
        : [];

    client.aclGroups = [...new Set(
      rawGroups
        .map((groupName) => this.__normalizeAclGroupName(groupName))
        .filter(Boolean)
    )];

    return client.aclGroups;
  }

  async getAvailableUplinkConfigs() {
    const basePath = typeof WG_UPLINK_CONFIGS_PATH === 'string'
      ? WG_UPLINK_CONFIGS_PATH.trim()
      : '';

    if (!basePath) {
      return [];
    }

    const entries = await fs.readdir(basePath, { withFileTypes: true }).catch((err) => {
      if (err && err.code === 'ENOENT') {
        return [];
      }

      throw new ServerError(`Unable to read uplink config directory (${basePath}): ${err.message}`, 400);
    });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(basePath, entry.name),
        interfaceName: path.posix.basename(entry.name, '.conf'),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async saveUplinkConfigFile({
    filename,
    content,
  }) {
    const basePath = typeof WG_UPLINK_CONFIGS_PATH === 'string'
      ? WG_UPLINK_CONFIGS_PATH.trim()
      : '';

    if (!basePath) {
      throw new ServerError('WG_UPLINK_CONFIGS_PATH is not configured.', 400);
    }

    const rawFilename = typeof filename === 'string' ? filename.trim() : '';
    if (!rawFilename) {
      throw new ServerError('Uplink config filename is required.', 400);
    }

    const normalizedInputFilename = /\.(conf|txt)$/i.test(rawFilename)
      ? rawFilename
      : `${rawFilename}.conf`;

    if (!/^[A-Za-z0-9_.-]+\.(conf|txt)$/i.test(normalizedInputFilename)) {
      throw new ServerError('Uplink config filename contains unsupported characters.', 400);
    }

    if (typeof content !== 'string' || !content.trim()) {
      throw new ServerError('Uplink config content is empty.', 400);
    }

    const basename = normalizedInputFilename.toLowerCase().endsWith('.txt')
      ? path.posix.basename(normalizedInputFilename, '.txt')
      : path.posix.basename(normalizedInputFilename, '.conf');
    const normalizedFilename = `${basename}.conf`;
    const interfaceName = basename;
    const hasInterfaceSection = /^\s*\[Interface\]\s*$/im.test(content);
    if (!hasInterfaceSection) {
      throw new ServerError('Uplink config must contain an [Interface] section.', 400);
    }

    const normalizedContent = ensureUplinkConfigTableOff(content);

    await fs.mkdir(basePath, { recursive: true }).catch((err) => {
      throw new ServerError(`Unable to create uplink config directory (${basePath}): ${err.message}`, 400);
    });

    const targetPath = path.posix.join(basePath, normalizedFilename);
    await fs.writeFile(targetPath, `${normalizedContent.trimEnd()}\n`, {
      mode: 0o600,
    }).catch((err) => {
      throw new ServerError(`Unable to write uplink config (${targetPath}): ${err.message}`, 400);
    });

    return {
      name: normalizedFilename,
      path: targetPath,
      interfaceName,
    };
  }

  async startTrafficHistorySampler() {
    await this.__loadRuntimeSettings();
    if (!this.__trafficSamplerEnabled || this.__trafficSamplerStarted) {
      return;
    }

    this.__trafficSamplerStarted = true;
    await this.__trafficHistory.init();

    const tick = async () => {
      if (!this.__trafficSamplerStarted) {
        return;
      }

      try {
        const clients = await this.getClients();
        await this.__trafficHistory.recordClients(clients);
      } catch (err) {
        debug(`Traffic sampler failed: ${err.message}`);
      } finally {
        if (this.__trafficSamplerStarted) {
          this.__trafficSamplerTimer = setTimeout(tick, this.__runtimeSettings.trafficSampleIntervalSeconds * 1000);
        }
      }
    };

    await tick();
  }

  async stopTrafficHistorySampler() {
    this.__trafficSamplerStarted = false;
    if (this.__trafficSamplerTimer) {
      clearTimeout(this.__trafficSamplerTimer);
      this.__trafficSamplerTimer = null;
    }

    if (this.__trafficSamplerEnabled) {
      await this.__trafficHistory.flush().catch((err) => {
        debug(`Traffic sampler flush failed: ${err.message}`);
      });
    }
  }

  __normalizeClientName(name) {
    if (typeof name !== 'string') {
      throw new ServerError('Missing: Name', 400);
    }

    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new ServerError('Missing: Name', 400);
    }

    if (normalizedName.length > 64) {
      throw new ServerError('Name too long', 400);
    }

    if ([...normalizedName].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })) {
      throw new ServerError('Name contains invalid control characters', 400);
    }

    return normalizedName;
  }

  __escapeShellArgument(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }

  __ipv4ToInteger(address) {
    return address.split('.').reduce((result, octet) => {
      return ((result << 8) >>> 0) + Number(octet);
    }, 0);
  }

  __parseIpv4Cidr(value, {
    defaultPrefix = 32,
  } = {}) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Expected IPv4 or CIDR value');
    }

    const normalizedValue = value.trim();
    const [address, prefixRaw] = normalizedValue.split('/');
    const prefix = typeof prefixRaw === 'undefined'
      ? defaultPrefix
      : Number.parseInt(prefixRaw, 10);

    if (!Util.isValidIPv4(address)) {
      throw new Error(`Invalid IPv4 address: ${value}`);
    }

    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new Error(`Invalid IPv4 prefix: ${value}`);
    }

    const integer = this.__ipv4ToInteger(address);
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    const network = integer & mask;
    const broadcast = (network | (~mask >>> 0)) >>> 0;

    return {
      address,
      prefix,
      canonical: `${address}/${prefix}`,
      network,
      broadcast,
    };
  }

  __getUplinkRulePriority(uplinkIndex, ruleIndex = 0) {
    return 11000 + (uplinkIndex * 1000) + ruleIndex;
  }

  __getUplinkMarkRulePriority(uplinkIndex) {
    return 10000 + uplinkIndex;
  }

  __getUplinkMarkValue(uplinkIndex) {
    return 200 + uplinkIndex;
  }

  __getProtectedUplinkMarkValue() {
    return 0x64;
  }

  __getProtectedUplinkRulePriority() {
    return 9999;
  }

  __getUplinkDomainSetName(uplink) {
    const suffix = crypto.createHash('sha1')
      .update(`${uplink.id}:${uplink.interfaceName}`)
      .digest('hex')
      .slice(0, 12);

    return `awg_dom_${suffix}`;
  }

  __getUplinkSourceSetName(uplink) {
    const suffix = crypto.createHash('sha1')
      .update(`${uplink.id}:${uplink.interfaceName}:src`)
      .digest('hex')
      .slice(0, 12);

    return `awg_uplink_src_${suffix}`;
  }

  async __syncSourceIpSet(setName, sourceRules) {
    // Create or update a hash:net ipset with the given source IPs/CIDRs
    // (hash:net supports both bare IPs and subnets, unlike hash:ip)
    await Util.exec(`ipset create ${setName} hash:net family inet -exist`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`ipset flush ${setName}`, {
      log: false,
    }).catch(() => {});
    for (const src of sourceRules) {
      if (src) {
        await Util.exec(`ipset add ${setName} ${src.trim()} -exist`, {
          log: false,
        }).catch(() => {});
      }
    }
  }

  __getRoutingCategorySetName(category) {
    const suffix = crypto.createHash('sha1')
      .update(`${category.id}:${category.uplinkId || 'none'}`)
      .digest('hex')
      .slice(0, 12);

    return `awg_cat_${suffix}`;
  }

  __normalizeClientIsolation(config) {
    const isolation = config && typeof config.clientIsolation === 'object' && !Array.isArray(config.clientIsolation)
      ? config.clientIsolation
      : this.__getDefaultClientIsolation();

    const enabled = isolation.enabled === true;
    const rules = Array.isArray(isolation.rules)
      ? isolation.rules
      : [];

    config.clientIsolation = {
      enabled,
      rules: rules
        .filter((rule) => rule && typeof rule === 'object' && !Array.isArray(rule))
        .map((rule) => ({
          id: typeof rule.id === 'string' && rule.id.length > 0
            ? rule.id
            : crypto.randomUUID(),
          action: rule.action === 'deny' ? 'deny' : 'allow',
          sourceType: typeof rule.sourceType === 'string'
            ? rule.sourceType
            : (typeof rule.sourceClientId === 'string' ? 'client' : 'client'),
          sourceValue: typeof rule.sourceValue === 'string'
            ? rule.sourceValue
            : (typeof rule.sourceClientId === 'string' ? rule.sourceClientId : ''),
          targetType: typeof rule.targetType === 'string'
            ? rule.targetType
            : (typeof rule.targetClientId === 'string' ? 'client' : 'client'),
          targetValue: typeof rule.targetValue === 'string'
            ? rule.targetValue
            : (typeof rule.targetClientId === 'string' ? rule.targetClientId : ''),
          bidirectional: rule.bidirectional !== false,
          enabled: rule.enabled !== false,
        })),
    };

    return config.clientIsolation;
  }

  __validateUplinkSettings(settings) {
    const normalizedSettings = {
      id: typeof settings?.id === 'string' && settings.id.trim() ? settings.id.trim() : crypto.randomUUID(),
      name: typeof settings?.name === 'string' && settings.name.trim() ? settings.name.trim() : '',
      enabled: settings && settings.enabled === true,
      configPath: typeof settings?.configPath === 'string' ? settings.configPath.trim() : '',
      interfaceName: typeof settings?.interfaceName === 'string' ? settings.interfaceName.trim() : '',
      table: Math.max(1, parseInt(settings?.table, 10) || 200),
      sourceRules: [...new Set(
        (Array.isArray(settings?.sourceRules) ? settings.sourceRules : [])
          .map((value) => this.__parseIpv4Cidr(value).canonical)
      )],
      geoSiteSync: settings && settings.geoSiteSync === true,
      geoIpSync: settings && settings.geoIpSync === true,
      destinationIps: [...new Set(
        (Array.isArray(settings?.destinationIps) ? settings.destinationIps : [])
          .map(value => { try { return this.__parseIpv4Cidr(value).canonical; } catch { return null; } })
          .filter(Boolean)
      )],
      destinationDomains: [...new Set(
        (Array.isArray(settings?.destinationDomains) ? settings.destinationDomains : [])
          .map((value) => {
            try { return this.__normalizeDomainName(value); }
            catch { return null; }
          })
          .filter(Boolean)
      )],
    };

    // Mutual exclusion: domains OR IPs, not both
    if (normalizedSettings.destinationIps.length > 0
      && normalizedSettings.destinationDomains.length > 0) {
      throw new ServerError(
        'Не возможно использовать 2 правила. Либо Домены назначения, либо IP Значения', 400);
    }

    // Merge GeoSite domains when sync enabled
    if (normalizedSettings.geoSiteSync) {
      const geoSiteCategories = settings?.geoSiteCategories
        || WG_BYPASS_GEOSITE
        || 'category-ru';
      const geoSiteDomains = this.__loadGeoSiteDomains(geoSiteCategories);
      normalizedSettings.destinationDomains = [...new Set([
        ...geoSiteDomains,
        ...normalizedSettings.destinationDomains,
      ])];
    }

    if (!normalizedSettings.name) {
      normalizedSettings.name = normalizedSettings.interfaceName || 'Uplink';
    }

    if (!normalizedSettings.enabled) {
      return normalizedSettings;
    }

    if (!normalizedSettings.configPath) {
      throw new ServerError('Uplink config path is required when uplink is enabled.', 400);
    }

    if (!normalizedSettings.configPath.endsWith('.conf')) {
      throw new ServerError('Uplink config path must point to a .conf file.', 400);
    }

    const interfaceFromPath = path.posix.basename(normalizedSettings.configPath, '.conf');
    const interfaceName = normalizedSettings.interfaceName || interfaceFromPath;

    if (!/^[A-Za-z0-9_.-]+$/.test(interfaceName)) {
      throw new ServerError(`Invalid uplink interface: ${interfaceName}`, 400);
    }

    if (interfaceName === 'wg0') {
      throw new ServerError('Uplink interface must not be wg0.', 400);
    }

    if (interfaceName !== interfaceFromPath) {
      throw new ServerError(`Uplink interface (${interfaceName}) must match config filename (${interfaceFromPath}).`, 400);
    }

    normalizedSettings.interfaceName = interfaceName;
    return normalizedSettings;
  }

  // Load GeoIP CIDRs from bypass files
  __loadGeoIpCidrs(categoryNames) {
    const cidrs = new Set();
    const categories = Array.isArray(categoryNames)
      ? categoryNames : typeof categoryNames === 'string'
        ? categoryNames.split(/[\s,;]+/) : [];
    for (const cat of categories) {
      const catName = cat.trim();
      if (!catName) continue;
      try {
        const data = require('fs').readFileSync(`/app/bypass/geoip/${catName}.txt`, 'utf8');
        for (let line of data.split('\n')) {
          line = line.trim();
          if (!line || line.startsWith('#')) continue;
          line = line.replace(/\s+#.*$/, '').trim();
          if (line) cidrs.add(line);
        }
      } catch { debug(`GeoIP file not found: ${catName}`); }
    }
    return [...cidrs];
  }

  async loadGeoIpCidrs() {
    const categories = (WG_BYPASS_GEOIP || 'ru').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const cat of categories) {
      const cidrs = this.__loadGeoIpCidrs([cat]);
      results.push({ category: cat, cidrs, count: cidrs.length });
    }
    return { totalCidrs: results.reduce((s, r) => s + r.count, 0), categories: results };
  }

  // Read cached GeoSite domains (fast, no recursive resolution)
  __loadGeoSiteDomains(categoryNames) {
    const domains = new Set();
    const categories = Array.isArray(categoryNames)
      ? categoryNames
      : typeof categoryNames === 'string'
        ? categoryNames.split(/[\s,;]+/)
        : [];
    const cacheDir = '/app/bypass/geosite';

    for (const cat of categories) {
      const catName = cat.trim();
      if (!catName) continue;
      try {
        const cachePath = path.join(cacheDir, `${catName}.txt`);
        const data = require('fs').readFileSync(cachePath, 'utf8');
        for (let line of data.split('\n')) {
          line = line.trim();
          if (!line || line.startsWith('#')) continue;
          line = line.replace(/\s+#.*$/, '').trim();
          line = line.replace(/\s+@\S+$/, '').trim();
          line = line.replace(/^(full|domain|regexp|keyword):/, '');
          if (line && line.includes('.')) domains.add(line);
        }
      } catch {
        debug(`GeoSite cache not found: ${catName}`);
      }
    }
    return [...domains];
  }

  // Recursively resolve GeoSite includes from data directory
  __resolveGeoSiteRecursive(categoryName, dataDir, visited = new Set()) {
    if (visited.has(categoryName)) return { domains: [], errors: [], files: 0 };
    visited.add(categoryName);

    const domains = new Set();
    const errors = [];
    let files = 0;
    // Try without extension first (git repo format), then .txt (cache format)
    let filePath = path.join(dataDir, categoryName);
    if (!require('fs').existsSync(filePath)) {
      filePath = path.join(dataDir, `${categoryName}.txt`);
    }

    try {
      const data = require('fs').readFileSync(filePath, 'utf8');
      files = 1;

      for (let line of data.split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        // Recursively resolve includes
        if (line.startsWith('include:')) {
          const includeName = line.slice(8).trim();
          if (includeName) {
            const result = this.__resolveGeoSiteRecursive(includeName, dataDir, visited);
            for (const d of result.domains) domains.add(d);
            files += result.files;
            errors.push(...result.errors);
          }
          continue;
        }

        // Parse domain line
        line = line.replace(/\s+#.*$/, '').trim();   // inline comment
        line = line.replace(/\s+@\S+$/, '').trim();  // @category tag
        // Strip GeoSite type prefixes (full:, domain:, regexp:, keyword:)
        line = line.replace(/^(full|domain|regexp|keyword):/, '');
        // Skip non-domain entries (keywords, bare words, regex patterns)
        if (line && line.includes('.')) domains.add(line);
      }
    } catch (err) {
      errors.push(`${categoryName}: ${err.message}`);
      debug(`GeoSite include not found: ${filePath}`);
    }

    return { domains: [...domains], errors, files };
  }

  // Sync GeoSite data from git repository
  async __syncGeoSiteGit() {
    const GEOSITE_DATA_PATH = require('../config').GEOSITE_DATA_PATH;
    const GEOSITE_GIT_REPO = require('../config').GEOSITE_GIT_REPO;
    const dataDir = GEOSITE_DATA_PATH || '/app/bypass/geosite-data';
    const fsSync = require('fs');

    try {
      // If already cloned — pull, otherwise clone
      if (fsSync.existsSync(path.join(dataDir, '.git'))) {
        debug('GeoSite git: pulling updates...');
        await Util.exec(`cd ${this.__escapeShellArgument(dataDir)} && git pull --ff-only 2>&1`, { log: false });
      } else {
        debug('GeoSite git: cloning repo...');
        // Remove stale directory if exists (but not a git repo)
        try { fsSync.rmSync(dataDir, { recursive: true }); } catch {}
        await Util.exec(`git clone --depth 1 ${this.__escapeShellArgument(GEOSITE_GIT_REPO)} ${this.__escapeShellArgument(dataDir)} 2>&1`, { log: false });
      }
      return { success: true };
    } catch (err) {
      debug(`GeoSite git sync failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // Load GeoSite domains, sync from git, resolve recursively, save cache
  async loadGeoSiteDomains({ categoryName = null } = {}) {
    // Sync from git first
    const gitResult = await this.__syncGeoSiteGit();
    if (!gitResult.success) {
      throw new ServerError(`GeoSite git sync failed: ${gitResult.error}`, 500);
    }

    const GEOSITE_DATA_PATH = require('../config').GEOSITE_DATA_PATH;
    const dataDir = path.join(GEOSITE_DATA_PATH || '/app/bypass/geosite-data', 'data');
    const cacheDir = '/app/bypass/geosite';

    const categories = categoryName
      ? (Array.isArray(categoryName) ? categoryName : String(categoryName).split(/[\s,;]+/))
      : (WG_BYPASS_GEOSITE || 'category-ru').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

    const results = [];
    for (const cat of categories) {
      const catName = cat.trim();
      if (!catName) continue;

      const result = this.__resolveGeoSiteRecursive(catName, dataDir);
      results.push({ category: catName, ...result });

      // Save cache
      if (result.domains.length > 0) {
        try {
          require('fs').mkdirSync(cacheDir, { recursive: true });
          const cacheLines = [`# GeoSite cache: ${catName}`, `# Resolved at: ${new Date().toISOString()}`,
            `# Domains: ${result.domains.length}`, `# Include files: ${result.files}`, ''];
          for (const d of result.domains.sort()) cacheLines.push(d);
          require('fs').writeFileSync(path.join(cacheDir, `${catName}.txt`), cacheLines.join('\n') + '\n');
        } catch (err) {
          debug(`Failed to save GeoSite cache: ${err.message}`);
        }
      }
    }

    return {
      totalDomains: results.reduce((s, r) => s + r.domains.length, 0),
      totalFiles: results.reduce((s, r) => s + r.files, 0),
      errors: results.flatMap(r => r.errors),
      categories: results.map(r => ({ category: r.category, domains: r.domains.length, files: r.files })),
    };
  }

  // Sync GeoSite domains to uplinks that have geoSiteSync enabled
  getGeoSiteStatus() {
    const categories = (WG_BYPASS_GEOSITE || 'category-ru').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const caches = [];
    for (const cat of categories) {
      try {
        const cachePath = path.join('/app/bypass/geosite', `${cat}.txt`);
        const stat = require('fs').statSync(cachePath);
        const data = require('fs').readFileSync(cachePath, 'utf8');
        const domains = data.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
        const filesLine = data.split('\n').find(l => l.startsWith('# Include files:'));
        const files = filesLine ? parseInt(filesLine.replace('# Include files:', '').trim(), 10) : 0;
        caches.push({ category: cat, domains, files, updatedAt: stat.mtime.toISOString() });
      } catch {
        caches.push({ category: cat, domains: 0, files: 0, updatedAt: null });
      }
    }
    return { categories: caches };
  }

  async syncGeoSiteToUplinks() {
    // Pull latest from git first
    await this.__syncGeoSiteGit();

    const config = await this.getConfig();
    const uplinks = this.__normalizeUplinkSettingsList(config);
    let updated = false;

    for (const uplink of uplinks) {
      if (!uplink.geoSiteSync) continue;

      const categories = WG_BYPASS_GEOSITE || 'category-ru';
      const geoSiteDomains = new Set(
        this.__loadGeoSiteDomains(categories)
      );

      if (geoSiteDomains.size === 0) continue;

      const manualDomains = new Set(
        (Array.isArray(uplink.destinationDomains) ? uplink.destinationDomains : [])
          .filter(d => !geoSiteDomains.has(d))
      );
      const merged = [...new Set([...geoSiteDomains, ...manualDomains])];

      if (merged.length !== (uplink.destinationDomains || []).length ||
          !merged.every(d => (uplink.destinationDomains || []).includes(d))) {
        config.uplinks = config.uplinks.map(u =>
          u.id === uplink.id ? { ...u, destinationDomains: merged } : u
        );
        if (config.uplink && config.uplink.id === uplink.id) {
          config.uplink.destinationDomains = merged;
        }
        updated = true;
      }
    }

    if (updated) {
      await this.saveConfig();
      await this.__syncUplinkRouting(config);

      // If DNS pre-resolve is enabled, re-resolve updated domains to keep ipsets in sync
      const dnsRouting = this.__normalizeDnsRoutingSettings(config);
      if (dnsRouting.resolveEnabled && !this.__resolveState.running) {
        this.startDnsResolve().catch((err) => {
          debug(`Auto-resolve after GeoSite sync failed: ${err.message}`);
        });
      }
    }

    return { updated };
  }

  __normalizeDomainName(value) {
    if (typeof value !== 'string') {
      throw new ServerError('Invalid domain name', 400);
    }

    const domain = value.trim().toLowerCase();
    if (!domain) {
      throw new ServerError('Invalid domain name', 400);
    }

    if (domain.length > 253) {
      throw new ServerError(`Domain name is too long: ${domain}`, 400);
    }

    if (!/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain)) {
      throw new ServerError(`Invalid domain name: ${domain}`, 400);
    }

    return domain;
  }

  __validateUplinkSettingsList(settingsList) {
    const normalizedSettingsList = (Array.isArray(settingsList) ? settingsList : [])
      .map((settings, index) => this.__validateUplinkSettings({
        ...settings,
        name: typeof settings?.name === 'string' && settings.name.trim()
          ? settings.name.trim()
          : `Uplink ${index + 1}`,
      }));

    const enabledSettings = normalizedSettingsList.filter((settings) => settings.enabled);
    const duplicateInterface = enabledSettings.find((settings, index) => enabledSettings.findIndex((candidate) => candidate.interfaceName === settings.interfaceName) !== index);
    if (duplicateInterface) {
      throw new ServerError(`Duplicate uplink interface: ${duplicateInterface.interfaceName}`, 400);
    }

    const duplicateTable = enabledSettings.find((settings, index) => enabledSettings.findIndex((candidate) => candidate.table === settings.table) !== index);
    if (duplicateTable) {
      throw new ServerError(`Duplicate uplink routing table: ${duplicateTable.table}`, 400);
    }

    return normalizedSettingsList;
  }

  __validateDnsRoutingSettings(settings) {
    const normalized = {
      enabled: settings && settings.enabled === true,
      resolveEnabled: settings && settings.resolveEnabled === true,
      upstreams: [...new Set(
        (Array.isArray(settings?.upstreams) ? settings.upstreams : typeof settings?.upstreams === 'string' ? settings.upstreams.split(/[\s,\n;]+/) : [])
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean)
      )],
    };

    normalized.upstreams = normalized.upstreams.map((upstream) => {
      if (net.isIP(upstream)) {
        return upstream;
      }

      return this.__normalizeDomainName(upstream);
    });

    if (normalized.enabled && normalized.upstreams.length === 0) {
      throw new ServerError('At least one upstream resolver is required when VPN DNS routing is enabled.', 400);
    }

    return normalized;
  }

  __validateClientIsolationRule(rule, clients) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new ServerError('Invalid isolation rule', 400);
    }

    const action = rule.action === 'deny' ? 'deny' : 'allow';
    const sourceType = typeof rule.sourceType === 'string' ? rule.sourceType.trim() : 'client';
    const targetType = typeof rule.targetType === 'string' ? rule.targetType.trim() : 'client';
    const sourceValue = typeof rule.sourceValue === 'string' ? rule.sourceValue.trim() : '';
    const targetValue = typeof rule.targetValue === 'string' ? rule.targetValue.trim() : '';

    if (!['all', 'client', 'group', 'cidr'].includes(sourceType)) {
      throw new ServerError(`Unsupported isolation sourceType: ${sourceType}`, 400);
    }

    if (!['all', 'client', 'group', 'cidr'].includes(targetType)) {
      throw new ServerError(`Unsupported isolation targetType: ${targetType}`, 400);
    }

    if ((sourceType !== 'all' && !sourceValue) || (targetType !== 'all' && !targetValue)) {
      throw new ServerError('Isolation rule requires source and target selectors', 400);
    }

    if (sourceType === 'client') {
      if (!clients[sourceValue]) {
        throw new ServerError(`Isolation rule source client not found: ${sourceValue}`, 400);
      }
    } else if (sourceType === 'all') {
      // No selector value required.
    } else if (sourceType === 'group') {
      this.__normalizeAclGroupName(sourceValue);
    } else {
      this.__parseIpv4Cidr(sourceValue);
    }

    if (targetType === 'client') {
      if (!clients[targetValue]) {
        throw new ServerError(`Isolation rule target client not found: ${targetValue}`, 400);
      }
    } else if (targetType === 'all') {
      // No selector value required.
    } else if (targetType === 'group') {
      this.__normalizeAclGroupName(targetValue);
    } else {
      this.__parseIpv4Cidr(targetValue);
    }

    if (sourceType === targetType && sourceValue === targetValue && sourceType !== 'all') {
      throw new ServerError('Isolation rule source and target selectors must differ', 400);
    }

    return {
      id: typeof rule.id === 'string' && rule.id.trim().length > 0
        ? rule.id.trim()
        : crypto.randomUUID(),
      action,
      sourceType,
      sourceValue: sourceType === 'all' ? '' : sourceValue,
      targetType,
      targetValue: targetType === 'all' ? '' : targetValue,
      bidirectional: rule.bidirectional !== false,
      enabled: rule.enabled !== false,
    };
  }

  __pruneClientIsolationRules(config) {
    const isolation = this.__normalizeClientIsolation(config);
    const seen = new Set();

    isolation.rules = isolation.rules.filter((rule) => {
      if (rule.sourceType === 'client' && !config.clients[rule.sourceValue]) {
        return false;
      }

      if (rule.targetType === 'client' && !config.clients[rule.targetValue]) {
        return false;
      }

      const dedupeKey = [
        rule.action,
        rule.sourceType,
        rule.sourceValue,
        rule.targetType,
        rule.targetValue,
        rule.bidirectional,
        rule.enabled,
      ].join(':');
      if (seen.has(dedupeKey)) {
        return false;
      }

      seen.add(dedupeKey);
      return true;
    });

    return isolation;
  }

  async __getValidatedUplinkConfig(configInput = null) {
    const config = configInput || await this.getConfig();
    const settings = this.__validateUplinkSettings(
      this.__getEffectiveUplinkSettings(config, this.__normalizeUplinkSettings(config))
    );

    if (!settings.enabled) {
      return null;
    }

    const configPath = settings.configPath;
    let configText = await fs.readFile(configPath, 'utf8').catch((err) => {
      throw new ServerError(`Unable to read uplink config (${configPath}): ${err.message}`, 400);
    });

    if (!hasUplinkConfigTableOff(configText)) {
      configText = ensureUplinkConfigTableOff(configText);
      await fs.writeFile(configPath, `${configText.trimEnd()}\n`, { mode: 0o600 }).catch((err) => {
        throw new ServerError(`Unable to update uplink config (${configPath}): ${err.message}`, 400);
      });
    }

    return {
      id: settings.id,
      name: settings.name,
      configPath,
      configPathShell: this.__escapeShellArgument(configPath),
      interfaceName: settings.interfaceName,
      table: settings.table,
      sourceRules: settings.sourceRules,
      destinationDomains: settings.destinationDomains,
    };
  }

  async __getValidatedUplinkConfigs(configInput = null) {
    const config = configInput || await this.getConfig();
    const settingsList = this.__validateUplinkSettingsList(
      this.__normalizeUplinkSettingsList(config)
        .map((uplink) => this.__getEffectiveUplinkSettings(config, uplink))
    );
    const uplinks = [];

    for (const settings of settingsList) {
      if (!settings.enabled) {
        continue;
      }

      const configText = await fs.readFile(settings.configPath, 'utf8').catch((err) => {
        throw new ServerError(`Unable to read uplink config (${settings.configPath}): ${err.message}`, 400);
      });

      if (!hasUplinkConfigTableOff(configText)) {
        const normalizedConfigText = ensureUplinkConfigTableOff(configText);
        await fs.writeFile(settings.configPath, `${normalizedConfigText.trimEnd()}\n`, { mode: 0o600 }).catch((err) => {
          throw new ServerError(`Unable to update uplink config (${settings.configPath}): ${err.message}`, 400);
        });
      }

      uplinks.push({
        id: settings.id,
        name: settings.name,
        configPath: settings.configPath,
        configPathShell: this.__escapeShellArgument(settings.configPath),
        interfaceName: settings.interfaceName,
        table: settings.table,
        sourceRules: settings.sourceRules,
        destinationDomains: settings.destinationDomains,
        destinationIps: settings.destinationIps,
      });
    }

    return uplinks;
  }

  async __removeUplinkPolicyRouting(uplink, uplinkIndex) {
    const manualSourceRules = Array.isArray(uplink.manualSourceRules) ? uplink.manualSourceRules : [];
    for (const [index, sourceRule] of manualSourceRules.entries()) {
      const priority = this.__getUplinkRulePriority(uplinkIndex, index);
      await Util.exec(`ip -4 rule del pref ${priority} from ${sourceRule} table ${uplink.table}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -D FORWARD -i wg0 -o ${uplink.interfaceName} -s ${sourceRule} -j ACCEPT`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -t nat -D POSTROUTING -s ${sourceRule} -o ${uplink.interfaceName} -j MASQUERADE`, {
        log: false,
      }).catch(() => {});
    }

    const mark = this.__getUplinkMarkValue(uplinkIndex);
    const markPriority = this.__getUplinkMarkRulePriority(uplinkIndex);
    const domainSetName = this.__getUplinkDomainSetName(uplink);
    const cidrSetName = `${domainSetName}_cidr`;
    const sourceSetName = this.__getUplinkSourceSetName(uplink);
    const hasSourceScope = Array.isArray(uplink.sourceRules) && uplink.sourceRules.length > 0;

    await Util.exec(`ip -4 rule del pref ${markPriority} fwmark ${mark} table ${uplink.table}`, {
      log: false,
    }).catch(() => {});

    // Domain rule — try source-scoped syntax first, then legacy global syntax
    if (hasSourceScope) {
      await Util.exec(`iptables -t mangle -D WG_EASY_UPLINK_DOMAINS -m mark --mark 0x0 -m set --match-set ${sourceSetName} src -m set --match-set ${domainSetName} dst -j MARK --set-mark ${mark}`, {
        log: false,
      }).catch(() => {});
    }
    // Legacy global syntax (clean up old rules during upgrade)
    await Util.exec(`iptables -t mangle -D WG_EASY_UPLINK_DOMAINS -m mark --mark 0x0 -m set --match-set ${domainSetName} dst -j MARK --set-mark ${mark}`, {
      log: false,
    }).catch(() => {});

    // CIDR rule — same dual-syntax approach
    if (hasSourceScope) {
      await Util.exec(`iptables -t mangle -D WG_EASY_UPLINK_DOMAINS -m mark --mark 0x0 -m set --match-set ${sourceSetName} src -m set --match-set ${cidrSetName} dst -j MARK --set-mark ${mark}`, {
        log: false,
      }).catch(() => {});
    }
    await Util.exec(`iptables -t mangle -D WG_EASY_UPLINK_DOMAINS -m mark --mark 0x0 -m set --match-set ${cidrSetName} dst -j MARK --set-mark ${mark}`, {
      log: false,
    }).catch(() => {});

    await Util.exec(`iptables -D FORWARD -i wg0 -o ${uplink.interfaceName} -m mark --mark ${mark} -j ACCEPT`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`iptables -t nat -D POSTROUTING -m mark --mark ${mark} -o ${uplink.interfaceName} -j MASQUERADE`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`iptables -D FORWARD -i ${uplink.interfaceName} -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`ipset destroy ${domainSetName}`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`ipset destroy ${cidrSetName}`, {
      log: false,
    }).catch(() => {});
    if (hasSourceScope) {
      await Util.exec(`ipset destroy ${sourceSetName}`, {
        log: false,
      }).catch(() => {});
    }

    for (const categoryRule of Array.isArray(uplink.categoryRules) ? uplink.categoryRules : []) {
      await Util.exec(`iptables -t mangle -D WG_EASY_UPLINK_DOMAINS -m mark --mark 0x0 -s ${categoryRule.sourceRule} -m set --match-set ${categoryRule.setName} dst -j MARK --set-mark ${mark}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`ipset destroy ${categoryRule.setName}`, {
        log: false,
      }).catch(() => {});
    }

    await Util.exec(`ip -4 route flush table ${uplink.table}`, {
      log: false,
    }).catch(() => {});
  }

  async __ensureUplinkDomainChainExists(chainName) {
    await Util.exec(`iptables -t mangle -N ${chainName}`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`iptables -t mangle -F ${chainName}`, {
      log: false,
    }).catch(() => {});
  }

  async __resolveDestinationDomains(destinationDomains) {
    const resolved = [];

    for (const domain of destinationDomains) {
      try {
        const records = await dns.lookup(domain, {
          all: true,
          family: 4,
          verbatim: true,
        });

        for (const record of records) {
          if (record && Util.isValidIPv4(record.address)) {
            resolved.push(record.address);
          }
        }
      } catch (err) {
        debug(`Failed to resolve uplink domain ${domain}: ${err.message}`);
      }
    }

    return [...new Set(resolved)];
  }

  async __syncUplinkDomainSet(uplink) {
    const domainSetName = this.__getUplinkDomainSetName(uplink);
    // eslint-disable-next-line no-console
    console.warn(`[Uplink] __syncUplinkDomainSet start, setName=${domainSetName}`);
    let resolvedAddresses;

    // Always try the resolve cache first — avoids slow DNS lookups
    // (cache is populated by pre-resolve, independent of resolveEnabled toggle)
    // eslint-disable-next-line no-console
    console.warn('[Uplink] Reading DNS resolve cache...');
    try {
      const cachePath = this.__getDnsResolveCachePath();
      // eslint-disable-next-line no-console
      console.warn(`[Uplink] Cache path: ${cachePath}`);
      const cache = JSON.parse(require('fs').readFileSync(cachePath, 'utf8'));
      const cachedIps = new Set();
      for (const domain of uplink.destinationDomains) {
        const entry = cache.entries && cache.entries[domain];
        if (entry && Array.isArray(entry.ips)) {
          for (const ip of entry.ips) cachedIps.add(ip);
        }
      }
      if (cachedIps.size > 0) {
        resolvedAddresses = [...cachedIps];
        // eslint-disable-next-line no-console
        console.warn(`[Uplink] Loaded ${resolvedAddresses.length} IPs from cache.`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[Uplink] Failed to load DNS resolve cache: ${err.message}`);
      /* cache read error — fall through to DNS resolve */ }

    if (!resolvedAddresses) {
      // eslint-disable-next-line no-console
      console.warn(`[Uplink] Cache miss — resolving ${uplink.destinationDomains.length} domain(s) via DNS...`);
      resolvedAddresses = await this.__resolveDestinationDomains(uplink.destinationDomains);
    }

    // eslint-disable-next-line no-console
    console.warn(`[Uplink] Creating ipset with ${resolvedAddresses.length} IPs...`);
    await Util.exec(`ipset create ${domainSetName} hash:ip family inet -exist`, {
      log: false,
    });
    await Util.exec(`ipset flush ${domainSetName}`, {
      log: false,
    });

    // Use ipset restore for bulk loading (much faster than individual adds)
    if (resolvedAddresses.length > 0) {
      const tmpFile = `/tmp/ipset_restore_dom_${domainSetName}.txt`;
      const lines = [`create ${domainSetName} hash:ip family inet -exist`, `flush ${domainSetName}`];
      for (const address of resolvedAddresses) {
        lines.push(`add ${domainSetName} ${address}`);
      }
      require('fs').writeFileSync(tmpFile, lines.join('\n') + '\n');
      await Util.exec(`ipset restore < ${this.__escapeShellArgument(tmpFile)}`, { log: false }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`Failed to restore domain ipset: ${err.message}`);
      });
    }

    return {
      setName: domainSetName,
      resolvedAddresses,
    };
  }

  async __syncRoutingCategorySet(category) {
    const setName = this.__getRoutingCategorySetName(category);
    let resolvedAddresses;

    // Always try the resolve cache first — avoids slow DNS lookups
    // (cache is populated by pre-resolve, independent of resolveEnabled toggle)
    try {
      const cachePath = this.__getDnsResolveCachePath();
      const cache = JSON.parse(require('fs').readFileSync(cachePath, 'utf8'));
      const cachedIps = new Set();
      for (const domain of category.domains) {
        const entry = cache.entries && cache.entries[domain];
        if (entry && Array.isArray(entry.ips)) {
          for (const ip of entry.ips) cachedIps.add(ip);
        }
      }
      if (cachedIps.size > 0) {
        resolvedAddresses = [...cachedIps];
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to load DNS resolve cache: ${err.message}`);
      /* cache read error — fall through to DNS resolve */ }

    if (!resolvedAddresses) {
      resolvedAddresses = await this.__resolveDestinationDomains(category.domains);
    }

    await Util.exec(`ipset create ${setName} hash:ip family inet -exist`, {
      log: false,
    });
    await Util.exec(`ipset flush ${setName}`, {
      log: false,
    });

    // Use ipset restore for bulk loading
    if (resolvedAddresses.length > 0) {
      const tmpFile = `/tmp/ipset_restore_cat_${setName}.txt`;
      const lines = [`create ${setName} hash:ip family inet -exist`, `flush ${setName}`];
      for (const address of resolvedAddresses) {
        lines.push(`add ${setName} ${address}`);
      }
      require('fs').writeFileSync(tmpFile, lines.join('\n') + '\n');
      await Util.exec(`ipset restore < ${this.__escapeShellArgument(tmpFile)}`, { log: false }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`Failed to restore category ipset: ${err.message}`);
      });
    }

    return {
      setName,
      resolvedAddresses,
    };
  }

  __extractIpv4RouteCidrs(routes = []) {
    return [...new Set(
      routes
        .map((route) => {
          const match = String(route).trim().match(/^(\d+\.\d+\.\d+\.\d+(?:\/\d+)?)\b/);
          if (!match) {
            return null;
          }

          try {
            return this.__parseIpv4Cidr(match[1]).canonical;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    )];
  }

  async __getProtectedUplinkCidrs(config, mainRoutes = []) {
    const runtime = await this.__loadRuntimeSettings();
    const manualProtectedCidrs = this.__normalizeUplinkProtectedCidrs(config);
    const protectedCidrs = [
      ...manualProtectedCidrs,
      this.__getRuntimeNetworkCidr(runtime),
      ...this.__extractIpv4RouteCidrs(mainRoutes),
    ];

    const resolvedHost = this.__resolvedWgHost || await this.__resolveWgHost({ required: false });
    if (Util.isValidIPv4(resolvedHost)) {
      protectedCidrs.push(`${resolvedHost}/32`);
    }

    return [...new Set(
      protectedCidrs
        .map((cidr) => this.__parseIpv4Cidr(cidr).canonical)
        .filter(Boolean)
    )];
  }

  async __syncProtectedUplinkSet(protectedCidrs) {
    const setName = 'awg_uplink_protected';

    await Util.exec(`ipset create ${setName} hash:net family inet -exist`, {
      log: false,
    });
    await Util.exec(`ipset flush ${setName}`, {
      log: false,
    });

    for (const cidr of protectedCidrs) {
      await Util.exec(`ipset add ${setName} ${cidr} -exist`, {
        log: false,
      });
    }

    return setName;
  }

  __getDnsRoutingPaths() {
    return {
      configPath: path.join(WG_PATH, 'dnsmasq-uplink.conf'),
      pidPath: path.join(WG_PATH, 'dnsmasq-uplink.pid'),
      logPath: path.join(WG_PATH, 'dnsmasq-uplink.log'),
    };
  }

  __getDnsResolveCachePath() {
    return path.join(WG_PATH, 'dns-resolve-cache.json');
  }

  async __stopDnsRouting() {
    const { pidPath, configPath } = this.__getDnsRoutingPaths();
    let pid = null;

    try {
      pid = (await fs.readFile(pidPath, 'utf8')).trim();
    } catch {}

    if (pid) {
      await Util.exec(`kill ${pid}`, {
        log: false,
      }).catch(() => {});
    }

    await Util.exec(`pkill -f ${this.__escapeShellArgument(`dnsmasq --conf-file=${configPath}`)}`, {
      log: false,
    }).catch(() => {});

    await Util.exec('iptables -t nat -D PREROUTING -i wg0 -p udp --dport 53 -j REDIRECT --to-ports 53', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -t nat -D PREROUTING -i wg0 -p tcp --dport 53 -j REDIRECT --to-ports 53', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -D INPUT -i wg0 -p udp --dport 53 -j ACCEPT', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -D INPUT -i wg0 -p tcp --dport 53 -j ACCEPT', {
      log: false,
    }).catch(() => {});

    await fs.rm(pidPath, { force: true }).catch(() => {});
    await fs.rm(configPath, { force: true }).catch(() => {});
    this.__dnsRoutingRuntime = null;
  }

  async __isDnsRoutingProcessRunning() {
    const { pidPath, configPath } = this.__getDnsRoutingPaths();

    try {
      const pid = (await fs.readFile(pidPath, 'utf8')).trim();
      if (pid) {
        await Util.exec(`kill -0 ${pid}`, {
          log: false,
        });
        return true;
      }
    } catch {}

    try {
      await Util.exec(`pgrep -f ${this.__escapeShellArgument(`dnsmasq --conf-file=${configPath}`)}`, {
        log: false,
      });
      return true;
    } catch {}

    return false;
  }

  __buildDnsRoutingRuntimeState(config, dnsRouting, uplinks, routingCategories) {
    let totalDomains = 0;
    for (const u of uplinks) { if (Array.isArray(u.destinationDomains)) totalDomains += u.destinationDomains.length; }
    for (const c of routingCategories) { if (Array.isArray(c.domains)) totalDomains += c.domains.length; }
    return {
      enabled: true,
      upstreams: [...dnsRouting.upstreams],
      uplinkIds: uplinks.map((uplink) => uplink.id),
      routingCategoryIds: routingCategories.map((category) => category.id),
      listenAddress: config.server.address,
      totalDomains,
    };
  }

  __isSameDnsRoutingRuntime(nextState) {
    if (!this.__dnsRoutingRuntime || !nextState) {
      return false;
    }

    return JSON.stringify(this.__dnsRoutingRuntime) === JSON.stringify(nextState);
  }

  async __writeDnsRoutingConfig(config, dnsRouting, uplinks, routingCategories) {
    const { configPath, pidPath, logPath } = this.__getDnsRoutingPaths();
    const lines = [
      '# Managed by amnezia-wg-easy. Do not edit manually.',
      'bind-interfaces',
      'interface=wg0',
      `listen-address=${config.server.address}`,
      'no-hosts',
      'cache-size=1000',
      `pid-file=${pidPath}`,
      'log-queries=extra',
      `log-facility=${logPath}`,
    ];

    if (dnsRouting.upstreams.length > 0) {
      lines.push('no-resolv');
      for (const upstream of dnsRouting.upstreams) {
        lines.push(`server=${upstream}`);
      }
    }

    for (const uplink of uplinks) {
      if (!Array.isArray(uplink.destinationDomains) || uplink.destinationDomains.length === 0) {
        continue;
      }

      const setName = this.__getUplinkDomainSetName(uplink);
      for (const domain of uplink.destinationDomains) {
        lines.push(`ipset=/${domain}/${setName}`);
      }
    }

    for (const category of routingCategories) {
      if (!Array.isArray(category.domains) || category.domains.length === 0) {
        continue;
      }

      const setName = this.__getRoutingCategorySetName(category);
      for (const domain of category.domains) {
        lines.push(`ipset=/${domain}/${setName}`);
      }
    }

    await fs.writeFile(configPath, `${lines.join('\n')}\n`, {
      mode: 0o600,
    });

    return {
      configPath,
      pidPath,
      logPath,
    };
  }

  async __startDnsRouting(config, dnsRouting, uplinks, routingCategories) {
    const { configPath } = await this.__writeDnsRoutingConfig(config, dnsRouting, uplinks, routingCategories);
    await Util.exec('iptables -I INPUT 1 -i wg0 -p udp --dport 53 -j ACCEPT', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -I INPUT 1 -i wg0 -p tcp --dport 53 -j ACCEPT', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -t nat -I PREROUTING 1 -i wg0 -p udp --dport 53 -j REDIRECT --to-ports 53', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -t nat -I PREROUTING 1 -i wg0 -p tcp --dport 53 -j REDIRECT --to-ports 53', {
      log: false,
    }).catch(() => {});

    try {
      await Util.exec(`dnsmasq --conf-file=${this.__escapeShellArgument(configPath)}`);
    } catch (err) {
      await this.__stopDnsRouting().catch(() => {});
      throw new ServerError(`Failed to start VPN DNS routing: ${err.message}`, 400);
    }

    this.__dnsRoutingRuntime = this.__buildDnsRoutingRuntimeState(config, dnsRouting, uplinks, routingCategories);
  }

  async __syncDnsRouting(config = null) {
    this.__dnsRoutingSyncPromise = this.__dnsRoutingSyncPromise.catch(() => {}).then(async () => {
      const resolvedConfig = config || await this.getConfig();
      const dnsRouting = this.__validateDnsRoutingSettings(this.__normalizeDnsRoutingSettings(resolvedConfig));
      const uplinks = this.__validateUplinkSettingsList(this.__normalizeUplinkSettingsList(resolvedConfig))
        .filter((uplink) => uplink.enabled);
      const routingCategories = this.__validateRoutingCategories(resolvedConfig)
        .filter((category) => category.enabled);

      if (!dnsRouting.enabled) {
        await this.__stopDnsRouting();
        return;
      }

      const nextRuntime = this.__buildDnsRoutingRuntimeState(resolvedConfig, dnsRouting, uplinks, routingCategories);
      if (this.__isSameDnsRoutingRuntime(nextRuntime) && await this.__isDnsRoutingProcessRunning()) {
        return;
      }

      await this.__stopDnsRouting();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await this.__startDnsRouting(resolvedConfig, dnsRouting, uplinks, routingCategories);
    });

    return this.__dnsRoutingSyncPromise;
  }

  __formatUplinkCommandError(prefix, err) {
    const message = err && err.message ? err.message : String(err);

    if (message.includes('resolvconf: command not found')) {
      return new ServerError(`${prefix}: resolvconf is missing. Rebuild the container with openresolv installed or remove DNS from awg1.conf.`, 400);
    }

    return new ServerError(`${prefix}: ${message}`, 400);
  }

  async __prepareUplinkConfig(uplink) {
    const rawConfigText = await fs.readFile(uplink.configPath, 'utf8').catch((err) => {
      throw new ServerError(`Unable to read uplink config (${uplink.configPath}): ${err.message}`, 400);
    });
    const sanitizedConfigText = rawConfigText
      .split(/\r?\n/)
      .filter((line) => !/^\s*DNS\s*=.*$/i.test(line))
      .join('\n');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-uplink-'));
    const tempConfigPath = path.join(tempDir, `${uplink.interfaceName}.conf`);
    await fs.writeFile(tempConfigPath, `${sanitizedConfigText.trimEnd()}\n`, {
      mode: 0o600,
    });
    await fs.chmod(tempConfigPath, 0o600);

    return {
      tempDir,
      tempConfigPath,
      tempConfigPathShell: this.__escapeShellArgument(tempConfigPath),
    };
  }

  async __bringUpUplinkInterface(uplink) {
    const prepared = await this.__prepareUplinkConfig(uplink);

    try {
      await Util.exec(`ip link show ${uplink.interfaceName}`, {
        log: false,
      }).then(() => Util.exec(`ip link delete dev ${uplink.interfaceName}`, {
        log: false,
      })).catch(() => {});

      await Util.exec(`wg-quick up ${prepared.tempConfigPathShell}`).catch((err) => {
        throw this.__formatUplinkCommandError(`Failed to start uplink interface ${uplink.interfaceName}`, err);
      });
    } finally {
      await fs.rm(prepared.tempDir, {
        force: true,
        recursive: true,
      }).catch(() => {});
    }
  }

  async __getMainTableRoutes() {
    const output = await Util.exec('ip -4 route show table main', {
      log: false,
    });

    return [...new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith('default '))
        .filter((line) => !line.startsWith('local '))
        .filter((line) => !line.startsWith('broadcast '))
        .filter((line) => !line.startsWith('unreachable '))
        .filter((line) => !line.startsWith('prohibit '))
        .filter((line) => !line.startsWith('blackhole '))
    )];
  }

  async __ensureIsolationChainExists(chainName) {
    await Util.exec(`iptables -N ${chainName}`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`iptables -F ${chainName}`, {
      log: false,
    }).catch(() => {});
  }

  __getIsolationSelectorCidrs(config, selectorType, selectorValue) {
    if (selectorType === 'all') {
      return [null];
    }

    if (selectorType === 'client') {
      const client = config.clients[selectorValue];
      return client ? [`${client.address}/32`] : [];
    }

    if (selectorType === 'group') {
      return Object.values(config.clients)
        .filter((client) => Array.isArray(client.aclGroups) && client.aclGroups.includes(selectorValue))
        .map((client) => `${client.address}/32`);
    }

    if (selectorType === 'cidr') {
      return [this.__parseIpv4Cidr(selectorValue).canonical];
    }

    return [];
  }

  async __appendIsolationRule(chainName, sourceCidr, targetCidr, action) {
    const targetAction = action === 'deny' ? 'DROP' : 'ACCEPT';
    const args = [`iptables -A ${chainName}`];

    if (sourceCidr) {
      args.push(`-s ${sourceCidr}`);
    }

    if (targetCidr) {
      args.push(`-d ${targetCidr}`);
    } else {
      args.push('-o wg0');
    }

    args.push(`-j ${targetAction}`);
    await Util.exec(args.join(' '));
  }

  // === GeoIP + GeoSite Bypass ===
  async __syncBypass() {
    const BYPASS_IPSET_IP = 'awg_bypass_ip';
    const BYPASS_IPSET_DOMAIN = 'awg_bypass_domain';
    const BYPASS_MARK = '0x1';
    const BYPASS_PREF = '10';

    if (!WG_BYPASS_ENABLED) {
      // Cleanup bypass rules if disabled
      try { await Util.exec(`iptables -t mangle -D PREROUTING -i awg0 -m set --match-set ${BYPASS_IPSET_IP} dst -j MARK --set-mark ${BYPASS_MARK}`, { log: false }); } catch {}
      try { await Util.exec(`iptables -t mangle -D PREROUTING -i awg0 -m set --match-set ${BYPASS_IPSET_DOMAIN} dst -j MARK --set-mark ${BYPASS_MARK}`, { log: false }); } catch {}
      try { await Util.exec(`ip rule del pref ${BYPASS_PREF} fwmark ${BYPASS_MARK} table main`, { log: false }); } catch {}
      try { await Util.exec(`ipset destroy ${BYPASS_IPSET_IP}`, { log: false }); } catch {}
      try { await Util.exec(`ipset destroy ${BYPASS_IPSET_DOMAIN}`, { log: false }); } catch {}
      return;
    }

    // Create ipsets
    await Util.exec(`ipset create ${BYPASS_IPSET_IP} hash:net -exist`, { log: false });
    await Util.exec(`ipset create ${BYPASS_IPSET_DOMAIN} hash:net -exist`, { log: false });
    await Util.exec(`ipset flush ${BYPASS_IPSET_IP}`, { log: false });
    await Util.exec(`ipset flush ${BYPASS_IPSET_DOMAIN}`, { log: false });

    // Load GeoIP CIDRs
    const geoipCategories = WG_BYPASS_GEOIP.split(',').map(s => s.trim()).filter(Boolean);
    for (const cat of geoipCategories) {
      const geoipFile = `/app/bypass/geoip/${cat}.txt`;
      try {
        const data = require('fs').readFileSync(geoipFile, 'utf8');
        const lines = data.split('\n').filter(l => l && !l.startsWith('#'));
        for (const cidr of lines) {
          try { await Util.exec(`ipset add ${BYPASS_IPSET_IP} ${cidr.trim()} -exist`, { log: false }); } catch {}
        }
      } catch { debug(`GeoIP file not found: ${geoipFile}`); }
    }

    // Load GeoSite domains for dnsmasq
    const geoSiteCategories = WG_BYPASS_GEOSITE.split(',').map(s => s.trim()).filter(Boolean);
    const bypassDomains = new Set(WG_BYPASS_DOMAINS.split(',').map(s => s.trim()).filter(Boolean));
    for (const cat of geoSiteCategories) {
      const geoSiteFile = `/app/bypass/geosite/${cat}.txt`;
      try {
        const data = require('fs').readFileSync(geoSiteFile, 'utf8');
        const lines = data.split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('include:'));
        for (const domain of lines) {
          bypassDomains.add(domain.trim());
        }
      } catch { debug(`GeoSite file not found: ${geoSiteFile}`); }
    }

    // Write dnsmasq bypass config
    if (bypassDomains.size > 0) {
      const dnsmasqBypassConf = require('path').join(require('../config').WG_PATH, 'dnsmasq-bypass.conf');
      let conf = '# Managed by amnezia-wg-easy. Do not edit.\n';
      for (const domain of bypassDomains) {
        conf += `ipset=/${domain}/${BYPASS_IPSET_DOMAIN}\n`;
      }
      require('fs').writeFileSync(dnsmasqBypassConf, conf);
    }

    // Add iptables mangle rules (BEFORE uplink rules)
    try { await Util.exec(`iptables -t mangle -D PREROUTING -i awg0 -m set --match-set ${BYPASS_IPSET_IP} dst -j MARK --set-mark ${BYPASS_MARK}`, { log: false }); } catch {}
    try { await Util.exec(`iptables -t mangle -D PREROUTING -i awg0 -m set --match-set ${BYPASS_IPSET_DOMAIN} dst -j MARK --set-mark ${BYPASS_MARK}`, { log: false }); } catch {}
    await Util.exec(`iptables -t mangle -I PREROUTING 1 -i awg0 -m set --match-set ${BYPASS_IPSET_IP} dst -j MARK --set-mark ${BYPASS_MARK}`, { log: false });
    await Util.exec(`iptables -t mangle -I PREROUTING 1 -i awg0 -m set --match-set ${BYPASS_IPSET_DOMAIN} dst -j MARK --set-mark ${BYPASS_MARK}`, { log: false });

    // Add ip rule to route marked traffic to main table
    try { await Util.exec(`ip rule del pref ${BYPASS_PREF} fwmark ${BYPASS_MARK} table main`, { log: false }); } catch {}
    await Util.exec(`ip rule add pref ${BYPASS_PREF} fwmark ${BYPASS_MARK} table main`, { log: false });
  }

  async __syncClientIsolationFirewall(config = null) {
    const chainName = 'WG_EASY_ISOLATION';
    const resolvedConfig = config || await this.getConfig();
    const isolation = this.__pruneClientIsolationRules(resolvedConfig);

    await Util.exec(`iptables -D FORWARD -i wg0 -j ${chainName}`, {
      log: false,
    }).catch(() => {});

    if (!isolation.enabled) {
      await Util.exec(`iptables -F ${chainName}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -X ${chainName}`, {
        log: false,
      }).catch(() => {});
      return;
    }

    await this.__ensureIsolationChainExists(chainName);

    for (const rule of isolation.rules) {
      if (!rule.enabled) {
        continue;
      }

      const sourceCidrs = this.__getIsolationSelectorCidrs(resolvedConfig, rule.sourceType, rule.sourceValue);
      const targetCidrs = this.__getIsolationSelectorCidrs(resolvedConfig, rule.targetType, rule.targetValue);

      for (const sourceCidr of sourceCidrs) {
        for (const targetCidr of targetCidrs) {
          if (sourceCidr && targetCidr && sourceCidr === targetCidr) {
            continue;
          }

          await this.__appendIsolationRule(chainName, sourceCidr, targetCidr, rule.action);

          if (rule.bidirectional && !(sourceCidr === null && targetCidr === null)) {
            await this.__appendIsolationRule(chainName, targetCidr, sourceCidr, rule.action);
          }
        }
      }
    }

    await Util.exec(`iptables -A ${chainName} -o wg0 -j DROP`);
    await Util.exec(`iptables -A ${chainName} -j RETURN`);
    await Util.exec(`iptables -I FORWARD 1 -i wg0 -j ${chainName}`, {
      log: false,
    });
  }

  async __configureUplinkRouting(config = null) {
    const uplinks = await this.__getValidatedUplinkConfigs(config);
    // eslint-disable-next-line no-console
    console.warn(`[Uplink] __configureUplinkRouting: ${uplinks.length} uplink(s)`);
    if (uplinks.length === 0) {
      return;
    }

    const resolvedConfig = config || await this.getConfig();
    const mainRoutes = await this.__getMainTableRoutes();
    const protectedCidrs = await this.__getProtectedUplinkCidrs(resolvedConfig, mainRoutes);
    const runtimeUplinks = [];
    const domainChainName = 'WG_EASY_UPLINK_DOMAINS';
    const protectedSetName = await this.__syncProtectedUplinkSet(protectedCidrs);
    const protectedMark = this.__getProtectedUplinkMarkValue();
    const protectedPriority = this.__getProtectedUplinkRulePriority();

    try {
      await Util.exec(`ip -4 rule add pref ${protectedPriority} fwmark ${protectedMark} table main`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -t mangle -D PREROUTING -i wg0 -m set --match-set ${protectedSetName} dst -j MARK --set-mark ${protectedMark}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -t mangle -I PREROUTING 1 -i wg0 -m set --match-set ${protectedSetName} dst -j MARK --set-mark ${protectedMark}`);
      await Util.exec(`iptables -t mangle -D PREROUTING -i wg0 -j ${domainChainName}`, {
        log: false,
      }).catch(() => {});
      await this.__ensureUplinkDomainChainExists(domainChainName);

      for (const [uplinkIndex, uplink] of uplinks.entries()) {
        const routingCategories = this.__getEnabledRoutingCategoriesForUplink(resolvedConfig, uplink.id);
        if (uplink.sourceRules.length === 0 && uplink.destinationDomains.length === 0 && routingCategories.length === 0) {
          // eslint-disable-next-line no-console
          console.warn(`Uplink "${uplink.name}" is enabled but has neither source rules nor destination domains; the tunnel will start without active policy rules.`);
        }

        await Util.exec(`wg-quick down ${uplink.interfaceName}`, {
          log: false,
        }).catch(() => {});
        await this.__bringUpUplinkInterface(uplink);
        await this.__removeUplinkPolicyRouting(uplink, uplinkIndex);

        for (const route of mainRoutes) {
          await Util.exec(`ip -4 route add table ${uplink.table} ${route}`, {
            log: false,
          }).catch(() => {});
        }

        await Util.exec(`ip -4 route replace default dev ${uplink.interfaceName} table ${uplink.table}`);
        const mark = this.__getUplinkMarkValue(uplinkIndex);
        const markPriority = this.__getUplinkMarkRulePriority(uplinkIndex);

        const hasIps = Array.isArray(uplink.destinationIps) && uplink.destinationIps.length > 0;
        const effectiveSourceRules = Array.isArray(uplink.sourceRules) ? uplink.sourceRules : [];
        const hasDomainDestinations = (uplink.destinationDomains.length > 0 || hasIps) && effectiveSourceRules.length > 0;

        // Only create fwmark routing rules if there are source-scoped destinations
        // or routing categories (categories always have per-client filters)
        if (hasDomainDestinations || routingCategories.length > 0) {
          await Util.exec(`ip -4 rule add pref ${markPriority} fwmark ${mark} table ${uplink.table}`);
          await Util.exec(`iptables -A FORWARD -i wg0 -o ${uplink.interfaceName} -m mark --mark ${mark} -j ACCEPT`);
          await Util.exec(`iptables -t nat -A POSTROUTING -m mark --mark ${mark} -o ${uplink.interfaceName} -j MASQUERADE`);
        }

        // Source ipset: scopes destination-based rules to assigned clients
        let srcSetName = null;
        if (effectiveSourceRules.length > 0 && (uplink.destinationDomains.length > 0 || hasIps)) {
          srcSetName = this.__getUplinkSourceSetName(uplink);
          await this.__syncSourceIpSet(srcSetName, effectiveSourceRules);
        }

        if (uplink.destinationDomains.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(`[Uplink] Syncing domain set for ${uplink.destinationDomains.length} domain(s)...`);
          const { setName, resolvedAddresses } = await this.__syncUplinkDomainSet(uplink);
          // eslint-disable-next-line no-console
          console.warn(`[Uplink] Domain set synced: ${resolvedAddresses.length} IP(s)`);
          if (effectiveSourceRules.length > 0) {
            await Util.exec(`iptables -t mangle -A ${domainChainName} -m mark --mark 0x0 -m set --match-set ${srcSetName} src -m set --match-set ${setName} dst -j MARK --set-mark ${mark}`);
            debug(`Uplink domain routing enabled via ${uplink.interfaceName} for ${uplink.destinationDomains.length} domain(s), ${resolvedAddresses.length} IPv4 target(s), scoped to ${effectiveSourceRules.length} source(s).`);
          } else {
            debug(`Uplink domain routing skipped for "${uplink.name}": no source rules (assign clients to this uplink first).`);
          }
        }

        // Destination IPs/CIDRs — add directly to hash:net ipset via bulk restore
        if (Array.isArray(uplink.destinationIps) && uplink.destinationIps.length > 0) {
          const cidrSetName = `${this.__getUplinkDomainSetName(uplink)}_cidr`;
          // Use ipset restore for bulk loading (much faster than individual adds)
          const tmpFile = `/tmp/ipset_restore_${uplink.interfaceName}.txt`;
          const lines = [`create ${cidrSetName} hash:net family inet maxelem 131072 -exist`, `flush ${cidrSetName}`];
          for (const cidr of uplink.destinationIps) {
            lines.push(`add ${cidrSetName} ${cidr}`);
          }
          require('fs').writeFileSync(tmpFile, lines.join('\n') + '\n');
          await Util.exec(`ipset restore < ${this.__escapeShellArgument(tmpFile)}`, { log: false });
          if (effectiveSourceRules.length > 0) {
            await Util.exec(`iptables -t mangle -A ${domainChainName} -m mark --mark 0x0 -m set --match-set ${srcSetName} src -m set --match-set ${cidrSetName} dst -j MARK --set-mark ${mark}`);
            debug(`Uplink CIDR routing enabled via ${uplink.interfaceName} for ${uplink.destinationIps.length} CIDR(s), scoped to ${effectiveSourceRules.length} source(s).`);
          } else {
            debug(`Uplink CIDR routing skipped for "${uplink.name}": no source rules (assign clients to this uplink first).`);
          }
        }

        const categoryRules = [];
        for (const category of routingCategories) {
          const { setName, resolvedAddresses } = await this.__syncRoutingCategorySet(category);

          for (const clientId of category.clientIds) {
            const client = (config || await this.getConfig()).clients[clientId];
            if (!client || !client.address) {
              continue;
            }

            const sourceRule = `${client.address}/32`;
            await Util.exec(`iptables -t mangle -A ${domainChainName} -m mark --mark 0x0 -s ${sourceRule} -m set --match-set ${setName} dst -j MARK --set-mark ${mark}`);
            categoryRules.push({
              categoryId: category.id,
              sourceRule,
              setName,
            });
          }

          debug(`Uplink category routing enabled via ${uplink.interfaceName} for category "${category.name}" with ${category.clientIds.length} client(s) and ${resolvedAddresses.length} IPv4 target(s).`);
        }

        await Util.exec(`iptables -A FORWARD -i ${uplink.interfaceName} -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`, {
          log: false,
        }).catch(() => {});

        const manualSourceRules = Array.isArray(uplink.manualSourceRules) ? uplink.manualSourceRules : [];

        for (const [ruleIndex, sourceRule] of manualSourceRules.entries()) {
          const priority = this.__getUplinkRulePriority(uplinkIndex, ruleIndex);
          await Util.exec(`ip -4 rule add pref ${priority} from ${sourceRule} table ${uplink.table}`);
          await Util.exec(`iptables -A FORWARD -i wg0 -o ${uplink.interfaceName} -s ${sourceRule} -j ACCEPT`);
          await Util.exec(`iptables -t nat -A POSTROUTING -s ${sourceRule} -o ${uplink.interfaceName} -j MASQUERADE`);
        }

        runtimeUplinks.push({
          ...uplink,
          categoryRules,
        });
        debug(`Uplink routing enabled via ${uplink.interfaceName} (table ${uplink.table}) for ${effectiveSourceRules.length} source-scoped domain rule(s), ${manualSourceRules.length} full-source rule(s).`);
      }

      await Util.exec(`iptables -t mangle -A ${domainChainName} -j RETURN`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -t mangle -I PREROUTING 1 -i wg0 -j ${domainChainName}`, {
        log: false,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[UplinkRouting] Failed to configure uplink routing: ${err.message}`);
      for (let index = runtimeUplinks.length - 1; index >= 0; index -= 1) {
        const uplink = runtimeUplinks[index];
        await this.__removeUplinkPolicyRouting(uplink, index).catch(() => {});
        await Util.exec(`wg-quick down ${uplink.interfaceName}`, {
          log: false,
        }).catch(() => {});
      }
      await Util.exec(`iptables -t mangle -F ${domainChainName}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -t mangle -X ${domainChainName}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`iptables -t mangle -D PREROUTING -i wg0 -m set --match-set ${protectedSetName} dst -j MARK --set-mark ${protectedMark}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`ip -4 rule del pref ${protectedPriority} fwmark ${protectedMark} table main`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`ipset destroy ${protectedSetName}`, {
        log: false,
      }).catch(() => {});
      throw err;
    }

    this.__uplinkRuntime = runtimeUplinks;
  }

  async __teardownUplinkRouting() {
    const uplinks = Array.isArray(this.__uplinkRuntime) ? this.__uplinkRuntime : [];
    const protectedSetName = 'awg_uplink_protected';
    const protectedMark = this.__getProtectedUplinkMarkValue();
    const protectedPriority = this.__getProtectedUplinkRulePriority();
    if (uplinks.length === 0) {
      await Util.exec(`iptables -t mangle -D PREROUTING -i wg0 -m set --match-set ${protectedSetName} dst -j MARK --set-mark ${protectedMark}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`ip -4 rule del pref ${protectedPriority} fwmark ${protectedMark} table main`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`ipset destroy ${protectedSetName}`, {
        log: false,
      }).catch(() => {});
      await Util.exec('iptables -t mangle -D PREROUTING -i wg0 -j WG_EASY_UPLINK_DOMAINS', {
        log: false,
      }).catch(() => {});
      await Util.exec('iptables -t mangle -F WG_EASY_UPLINK_DOMAINS', {
        log: false,
      }).catch(() => {});
      await Util.exec('iptables -t mangle -X WG_EASY_UPLINK_DOMAINS', {
        log: false,
      }).catch(() => {});
      return;
    }

    for (let index = uplinks.length - 1; index >= 0; index -= 1) {
      const uplink = uplinks[index];
      await this.__removeUplinkPolicyRouting(uplink, index);
      await Util.exec(`wg-quick down ${uplink.interfaceName}`, {
        log: false,
      }).catch(() => {});
    }

    await Util.exec('iptables -t mangle -D PREROUTING -i wg0 -j WG_EASY_UPLINK_DOMAINS', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -t mangle -F WG_EASY_UPLINK_DOMAINS', {
      log: false,
    }).catch(() => {});
    await Util.exec('iptables -t mangle -X WG_EASY_UPLINK_DOMAINS', {
      log: false,
    }).catch(() => {});
    await Util.exec(`iptables -t mangle -D PREROUTING -i wg0 -m set --match-set ${protectedSetName} dst -j MARK --set-mark ${protectedMark}`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`ip -4 rule del pref ${protectedPriority} fwmark ${protectedMark} table main`, {
      log: false,
    }).catch(() => {});
    await Util.exec(`ipset destroy ${protectedSetName}`, {
      log: false,
    }).catch(() => {});

    this.__uplinkRuntime = [];
  }

  __isSameUplinkConfig(current, next) {
    if (!current || !next) {
      return false;
    }

    return current.configPath === next.configPath
      && current.interfaceName === next.interfaceName
      && String(current.table) === String(next.table)
      && JSON.stringify(current.sourceRules) === JSON.stringify(next.sourceRules)
      && JSON.stringify(current.destinationDomains || []) === JSON.stringify(next.destinationDomains || [])
      && JSON.stringify(current.destinationIps || []) === JSON.stringify(next.destinationIps || []);
  }

  __isSameUplinkConfigList(currentList, nextList) {
    if (!Array.isArray(currentList) || !Array.isArray(nextList) || currentList.length !== nextList.length) {
      return false;
    }

    return currentList.every((current, index) => this.__isSameUplinkConfig(current, nextList[index]));
  }

  async __getInterfaceIpv4Address(interfaceName) {
    const output = await Util.exec(`ip -4 -o addr show dev ${interfaceName}`, {
      log: false,
    }).catch(() => '');

    const match = output.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\/\d+\b/);
    return match ? match[1] : null;
  }

  async __getUplinkPeerState(interfaceName) {
    const dump = await Util.exec(`wg show ${interfaceName} dump`, {
      log: false,
    }).catch(() => '');

    const peerLine = dump
      .trim()
      .split('\n')
      .slice(1)
      .find(Boolean);

    if (!peerLine) {
      return {
        latestHandshakeAt: null,
        transferRx: 0,
        transferTx: 0,
      };
    }

    const [
      publicKey,
      preSharedKey,
      endpoint,
      allowedIps,
      latestHandshakeAt,
      transferRx,
      transferTx,
    ] = peerLine.split('\t');

    return {
      publicKey,
      preSharedKey,
      endpoint,
      allowedIps,
      latestHandshakeAt: latestHandshakeAt && latestHandshakeAt !== '0'
        ? new Date(Number(`${latestHandshakeAt}000`))
        : null,
      transferRx: Number(transferRx || 0),
      transferTx: Number(transferTx || 0),
    };
  }

  async __runUplinkProbe(interfaceName, sourceAddress) {
    const testTable = 59999;
    const testPriority = 10999;

    await Util.exec(`ip -4 route replace table ${testTable} default dev ${interfaceName}`, {
      log: false,
    });
    await Util.exec(`ip -4 rule add pref ${testPriority} from ${sourceAddress}/32 table ${testTable}`, {
      log: false,
    }).catch(() => {});

    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: '1.1.1.1',
          port: 443,
          localAddress: sourceAddress,
        });

        const timer = setTimeout(() => {
          socket.destroy(new Error('Timeout'));
        }, 5000);

        socket.on('connect', () => {
          clearTimeout(timer);
          socket.end();
          resolve();
        });

        socket.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        socket.on('close', () => {
          clearTimeout(timer);
        });
      });

      return {
        connected: true,
        error: null,
      };
    } catch (err) {
      return {
        connected: false,
        error: err.message || String(err),
      };
    } finally {
      await Util.exec(`ip -4 rule del pref ${testPriority} from ${sourceAddress}/32 table ${testTable}`, {
        log: false,
      }).catch(() => {});
      await Util.exec(`ip -4 route flush table ${testTable}`, {
        log: false,
      }).catch(() => {});
    }
  }

  async __syncUplinkRouting(config = null) {
    const desiredUplinks = await this.__getValidatedUplinkConfigs(config);

    if (desiredUplinks.length === 0) {
      await this.__teardownUplinkRouting().catch((err) => {
        debug(`Failed to tear down uplink routing: ${err.message}`);
      });
      return;
    }

    if (this.__isSameUplinkConfigList(this.__uplinkRuntime, desiredUplinks)) {
      return;
    }

    await this.__teardownUplinkRouting().catch((err) => {
      debug(`Failed to tear down uplink routing: ${err.message}`);
    });
    await this.__configureUplinkRouting(config);
  }

  async __refreshRuntimeUplinkDomains() {
    const runtimeUplinks = Array.isArray(this.__uplinkRuntime) ? this.__uplinkRuntime : [];

    for (const uplink of runtimeUplinks) {
      if (!Array.isArray(uplink.destinationDomains) || uplink.destinationDomains.length === 0) {
        continue;
      }

      try {
        const { resolvedAddresses } = await this.__syncUplinkDomainSet(uplink);
        debug(`Refreshed uplink domain set for ${uplink.interfaceName}: ${resolvedAddresses.length} IPv4 target(s).`);
      } catch (err) {
        debug(`Failed to refresh uplink domain set for ${uplink.interfaceName}: ${err.message}`);
      }

      const refreshedCategorySetNames = new Set();
      for (const categoryRule of Array.isArray(uplink.categoryRules) ? uplink.categoryRules : []) {
        if (refreshedCategorySetNames.has(categoryRule.setName)) {
          continue;
        }

        const config = await this.getConfig();
        const category = this.__validateRoutingCategories(config)
          .find((candidate) => candidate.id === categoryRule.categoryId);
        if (!category) {
          continue;
        }

        try {
          const { resolvedAddresses } = await this.__syncRoutingCategorySet(category);
          refreshedCategorySetNames.add(categoryRule.setName);
          debug(`Refreshed routing category set for ${category.name}: ${resolvedAddresses.length} IPv4 target(s).`);
        } catch (err) {
          debug(`Failed to refresh routing category set for ${category.name}: ${err.message}`);
        }
      }
    }
  }

  __escapePrometheusLabelValue(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/"/g, '\\"');
  }

  __assertValidRestoreConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ServerError('Invalid backup format', 400);
    }

    if (!config.server || typeof config.server !== 'object' || Array.isArray(config.server)) {
      throw new ServerError('Invalid backup format', 400);
    }

    if (!config.clients || typeof config.clients !== 'object' || Array.isArray(config.clients)) {
      throw new ServerError('Invalid backup format', 400);
    }

    if ('clientIsolation' in config) {
      if (!config.clientIsolation || typeof config.clientIsolation !== 'object' || Array.isArray(config.clientIsolation)) {
        throw new ServerError('Invalid backup format', 400);
      }

      if ('rules' in config.clientIsolation && !Array.isArray(config.clientIsolation.rules)) {
        throw new ServerError('Invalid backup format', 400);
      }
    }

    if ('uplink' in config) {
      if (!config.uplink || typeof config.uplink !== 'object' || Array.isArray(config.uplink)) {
        throw new ServerError('Invalid backup format', 400);
      }

      if ('sourceRules' in config.uplink && !Array.isArray(config.uplink.sourceRules) && typeof config.uplink.sourceRules !== 'string') {
        throw new ServerError('Invalid backup format', 400);
      }

      if ('destinationDomains' in config.uplink && !Array.isArray(config.uplink.destinationDomains) && typeof config.uplink.destinationDomains !== 'string') {
        throw new ServerError('Invalid backup format', 400);
      }
    }

    if ('uplinks' in config) {
      if (!Array.isArray(config.uplinks)) {
        throw new ServerError('Invalid backup format', 400);
      }

      for (const uplink of config.uplinks) {
        if (!uplink || typeof uplink !== 'object' || Array.isArray(uplink)) {
          throw new ServerError('Invalid backup format', 400);
        }

        if ('sourceRules' in uplink && !Array.isArray(uplink.sourceRules) && typeof uplink.sourceRules !== 'string') {
          throw new ServerError('Invalid backup format', 400);
        }

        if ('destinationDomains' in uplink && !Array.isArray(uplink.destinationDomains) && typeof uplink.destinationDomains !== 'string') {
          throw new ServerError('Invalid backup format', 400);
        }
      }
    }

    if ('uplinkProtectedCidrs' in config && !Array.isArray(config.uplinkProtectedCidrs) && typeof config.uplinkProtectedCidrs !== 'string') {
      throw new ServerError('Invalid backup format', 400);
    }

    if ('dnsRouting' in config) {
      if (!config.dnsRouting || typeof config.dnsRouting !== 'object' || Array.isArray(config.dnsRouting)) {
        throw new ServerError('Invalid backup format', 400);
      }

      if ('upstreams' in config.dnsRouting && !Array.isArray(config.dnsRouting.upstreams) && typeof config.dnsRouting.upstreams !== 'string') {
        throw new ServerError('Invalid backup format', 400);
      }
    }

    for (const field of ['privateKey', 'publicKey', 'address']) {
      if (typeof config.server[field] !== 'string' || config.server[field].length === 0) {
        throw new ServerError('Invalid backup format', 400);
      }
    }

    for (const client of Object.values(config.clients)) {
      if (!client || typeof client !== 'object' || Array.isArray(client)) {
        throw new ServerError('Invalid backup format', 400);
      }

      if (typeof client.name !== 'string' || typeof client.address !== 'string' || typeof client.publicKey !== 'string') {
        throw new ServerError('Invalid backup format', 400);
      }

      if (typeof client.enabled !== 'boolean') {
        throw new ServerError('Invalid backup format', 400);
      }

      if ('aclGroups' in client && !Array.isArray(client.aclGroups) && typeof client.aclGroups !== 'string') {
        throw new ServerError('Invalid backup format', 400);
      }
    }
  }

  async __fetchPublicIp(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let req;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => {
        if (req) {
          req.destroy(new Error('Timeout'));
          return;
        }
        finish(reject, new Error('Timeout'));
      }, 5000);

      req = https.get(url, {
        headers: {
          'User-Agent': 'amnezia-wg-easy',
        },
      }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          finish(reject, new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const text = body.trim();
          const ipv4 = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
          if (ipv4) {
            finish(resolve, ipv4[0]);
            return;
          }

          const ipv6 = text.match(/\b(?:[A-Fa-f0-9:]+:+)+[A-Fa-f0-9]+\b/);
          if (ipv6) {
            finish(resolve, ipv6[0]);
            return;
          }

          finish(reject, new Error('Response does not contain IP address'));
        });
      });

      req.on('error', (err) => {
        finish(reject, err);
      });
      req.setTimeout(5000, () => {
        req.destroy(new Error('Timeout'));
      });
    });
  }

  async __resolveWgHost({ required = false } = {}) {
    const configuredHost = await this.__getConfiguredWgHost();
    if (!configuredHost) {
      this.__resolvedWgHost = null;
      if (required) {
        throw new Error('WG_HOST is not configured yet.');
      }
      return null;
    }

    if (configuredHost.toLowerCase() !== 'auto') {
      this.__resolvedWgHost = configuredHost;
      return this.__resolvedWgHost;
    }

    const providers = [
      'https://2ip.ru',
      'https://ifconfig.me/ip',
      'https://api.ipify.org',
      'https://ipv4.icanhazip.com',
      'https://checkip.amazonaws.com',
      'https://ipinfo.io/ip',
      'https://v4.ident.me',
      'https://ipv4.seeip.org',
      'https://myexternalip.com/raw',
    ];

    for (const provider of providers) {
      try {
        const detectedIp = await this.__fetchPublicIp(provider);
        this.__resolvedWgHost = detectedIp;
        debug(`WG_HOST auto detected via ${provider}: ${detectedIp}`);
        // eslint-disable-next-line no-console
        console.log(`[WG_HOST] Auto-detected public IP via ${provider}: ${detectedIp}`);
        return this.__resolvedWgHost;
      } catch (err) {
        debug(`WG_HOST auto detection failed via ${provider}: ${err.message}`);
      }
    }

    if (required) {
      throw new Error('WG_HOST=auto but failed to detect public IP from all configured providers');
    }

    this.__resolvedWgHost = null;
    return null;
  }

  async __buildConfig() {
    return Promise.resolve().then(async () => {
      const runtime = await this.__loadRuntimeSettings();
      await this.__resolveWgHost({ required: false });

      debug('Loading configuration...');
      let config;
      try {
        config = await this.__configStore.getConfig();
        if (config) {
          debug('Configuration loaded from SQLite.');
        } else {
          config = await fs.readFile(path.join(WG_PATH, 'wg0.json'), 'utf8');
          config = JSON.parse(config);
          await this.__configStore.setConfig(config);
          debug('Configuration loaded from wg0.json and migrated to SQLite.');
        }
      } catch (err) {
        const privateKey = await Util.exec('wg genkey');
        const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
          log: 'echo ***hidden*** | wg pubkey',
        });
        const address = runtime.wgDefaultAddress.replace('x', '1');

        const defaultUplink = this.__getDefaultUplinkSettings();

        config = {
          server: {
            privateKey,
            publicKey,
            address,
            jc: JC,
            jmin: JMIN,
            jmax: JMAX,
            s1: S1,
            s2: S2,
            h1: H1,
            h2: H2,
            h3: H3,
            h4: H4,
          },
          clients: {},
          clientIsolation: this.__getDefaultClientIsolation(),
          clientUplinkAssignments: {},
          uplinkProtectedCidrs: [],
          uplinks: [defaultUplink],
          uplink: { ...defaultUplink },
        };
        await this.__configStore.setConfig(config);
        debug('Configuration generated.');
      }

      for (const client of Object.values(config.clients)) {
        this.__normalizeClientAclGroups(client);
      }
      this.__normalizeClientIsolation(config);
      this.__pruneClientIsolationRules(config);
      this.__normalizeUplinkSettingsList(config);
      this.__normalizeClientUplinkAssignments(config);
      this.__normalizeUplinkProtectedCidrs(config);
      this.__normalizeDnsRoutingSettings(config);

      return config;
    });
  }

  __migrateHeaderProtection(config) {
    // v3: HeaderProtectionKey миграция (must-match поле — меняем только осознанно).
    // Инлайн-require: в исходнике этих экспортов нет в деструктуризации (их
    // добавляет wireguard-patch.sh только в v3-сборках).
    const awg3Cfg = require('../config');
    if (awg3Cfg.AMNEZIA_VERSION !== '3') {
      return;
    }

    const { HEADER_PROTECTION_KEY_ENABLE, HEADER_PROTECTION_KEY } = awg3Cfg;
    const prevHpk = config.server.headerProtectionKey || '';
    if (HEADER_PROTECTION_KEY_ENABLE) {
      let newHpk = prevHpk;
      if (HEADER_PROTECTION_KEY && HEADER_PROTECTION_KEY !== prevHpk) {
        // env-пин: явная ротация ключа администратором
        newHpk = HEADER_PROTECTION_KEY;
        debug('HeaderProtectionKey rotated from env — clients must re-import configs');
      } else if (!prevHpk) {
        // Первый запуск с HPK: генерируем ОДИН раз и сохраняем в persisted config
        // (в config.js ключ не генерируется — иначе ротация при каждом рестарте)
        newHpk = crypto.randomBytes(32).toString('base64');
        debug('HeaderProtectionKey generated and persisted — clients must re-import configs');
      }
      if (newHpk !== prevHpk) {
        config.server.headerProtectionKey = newHpk;
        // Требование HeaderProtectionKey: S3/S4 не меньше 12 (config.js)
        const s3 = Number(config.server.s3);
        const s4 = Number(config.server.s4);
        if (Number.isFinite(s3) && s3 < 12) {
          config.server.s3 = 12 + Math.floor(Math.random() * (55 - 12 + 1));
          debug(`S3 raised to ${config.server.s3} (HeaderProtectionKey requirement)`);
        }
        if (Number.isFinite(s4) && s4 < 12) {
          config.server.s4 = 12 + Math.floor(Math.random() * (27 - 12 + 1));
          debug(`S4 raised to ${config.server.s4} (HeaderProtectionKey requirement)`);
        }
      }
    } else if (prevHpk) {
      // Явное отключение: убираем HPK (все клиенты переимпортируются)
      config.server.headerProtectionKey = '';
      debug('HeaderProtectionKey disabled — removed from server config');
    }

    // Backfill v3-таймеров/padding (не must-match, но должны быть в серверном конфиге)
    for (const [prop, envVal] of [
      ['contentPaddingAddition', awg3Cfg.CONTENT_PADDING_ADDITION],
      ['rekeyAfterTime', awg3Cfg.REKEY_AFTER_TIME],
      ['rekeyTimeout', awg3Cfg.REKEY_TIMEOUT],
      ['rejectAfterTime', awg3Cfg.REJECT_AFTER_TIME],
      ['keepaliveTimeout', awg3Cfg.KEEPALIVE_TIMEOUT],
      ['maxHandshakeAttempts', awg3Cfg.MAX_HANDSHAKE_ATTEMPTS],
    ]) {
      if (!config.server[prop] && envVal) {
        config.server[prop] = envVal;
      }
    }
  }

  __migrateMimicryProfile(config) {
    // v2/v3: мимикрия CPS (I1-I5) через MIMICRY_PROFILE (dns|tls|quic|sip).
    // I-значения — декои: их отправляет инициатор хендшейка, принимающая
    // сторона не валидирует (must-match только S1-S4/H1-H4/HeaderProtectionKey).
    // Ротация НЕ ломает существующих клиентов — переэкспорт нужен только
    // чтобы применить новый профиль декоя клиентам.
    const cfg = require('../config');
    if (cfg.AMNEZIA_VERSION !== '2' && cfg.AMNEZIA_VERSION !== '3') {
      return;
    }

    // Без единой MIMICRY_* в env — no-op: на существующих деплоях
    // persisted I-значения не ротируются (обратная совместимость).
    const MIMICRY_ENV_KEYS = ['MIMICRY_PROFILE', 'MIMICRY_BROWSER', 'MIMICRY_DOMAIN', 'MIMICRY_REGION', 'MIMICRY_ONLY_I1'];
    if (MIMICRY_ENV_KEYS.every((k) => process.env[k] === undefined)) {
      return;
    }

    const mimicry = require('../lib/mimicry');
    const normI = (val) => (val === '' || val === '0' || val === 'null') ? '' : val;

    // env-пины I1..I5 применяются всегда (прецедент HeaderProtectionKey env-pin)
    for (let i = 1; i <= 5; i++) {
      const envVal = process.env[`I${i}`];
      if (envVal !== undefined) {
        config.server[`i${i}`] = normI(envVal);
      }
    }

    const stored = {
      profile: config.server.mimicryProfile || 'dns',
      browser: config.server.mimicryBrowser || 'chrome',
      domain: config.server.mimicryDomain || '',
      region: config.server.mimicryRegion || 'world',
      onlyI1: !!config.server.mimicryOnlyI1,
    };
    const envTuple = {
      profile: cfg.MIMICRY_PROFILE,
      browser: cfg.MIMICRY_BROWSER,
      domain: cfg.MIMICRY_DOMAIN,
      region: cfg.MIMICRY_REGION,
      onlyI1: cfg.MIMICRY_ONLY_I1,
    };
    const changed = stored.profile !== envTuple.profile
      || stored.browser !== envTuple.browser
      || stored.domain !== envTuple.domain
      || stored.region !== envTuple.region
      || stored.onlyI1 !== envTuple.onlyI1;
    if (!changed) {
      return;
    }

    // Профиль сменился (или первый запуск с MIMICRY_* env): регенерируем I1-I5.
    // Поля с env-пином сохраняют значение пина (не перезаписываются).
    const generated = mimicry.generateProfile({
      profile: envTuple.profile,
      browser: envTuple.browser,
      domain: envTuple.domain,
      region: envTuple.region,
      onlyI1: envTuple.onlyI1,
      dnsSites: cfg.DNS_SITES,
      dnsMimicAll: process.env.I_DNS_MIMIC_ALL === 'true',
      rMin: cfg.I_R_MIN,
      rMax: cfg.I_R_MAX,
    });
    const gen = { i1: generated.i1, i2: generated.i2, i3: generated.i3, i4: generated.i4, i5: generated.i5 };
    for (const [key, val] of Object.entries(gen)) {
      const envVal = process.env[key.toUpperCase()];
      if (envVal === undefined) {
        config.server[key] = val;
      }
    }
    config.server.mimicryProfile = envTuple.profile;
    config.server.mimicryBrowser = envTuple.browser;
    config.server.mimicryDomain = envTuple.domain;
    config.server.mimicryRegion = envTuple.region;
    config.server.mimicryOnlyI1 = envTuple.onlyI1;
    // eslint-disable-next-line no-console
    console.warn(`Mimicry profile changed to '${envTuple.profile}' (browser: ${envTuple.browser}, region: ${envTuple.region}) — existing clients unaffected (I-values are decoys); re-export client configs to apply the new profile`);
  }

  async __initializeConfigUnlocked() {
    await this.__loadRuntimeSettings();
    const config = await this.__buildConfig();

    // Auto-fix: ensure server + client addresses match env WG_DEFAULT_ADDRESS
    const envAddress = this.__runtimeSettings.wgDefaultAddress.replace('x', '1');
    const envPrefix = envAddress.split('.').slice(0, 3).join('.');
    if (config.server.address !== envAddress) {
      debug(`WG_DEFAULT_ADDRESS changed: ${config.server.address} → ${envAddress}`);
      config.server.address = envAddress;
    }
    // Check all clients — if any are outside the env subnet, fix them
    let clientIdx = 2; // start from .2
    for (const client of Object.values(config.clients)) {
      const clientPrefix = (client.address || '').split('.').slice(0, 3).join('.');
      if (clientPrefix !== envPrefix) {
        const newAddr = `${envPrefix}.${clientIdx}`;
        debug(`Client "${client.name}" address fixed: ${client.address} → ${newAddr}`);
        client.address = newAddr;
      }
      const lastOctet = parseInt((client.address || '').split('.')[3], 10);
      if (!Number.isNaN(lastOctet) && lastOctet >= clientIdx) {
        clientIdx = lastOctet + 1;
      }
    }

    this.__migrateHeaderProtection(config);
    this.__migrateMimicryProfile(config);

    await this.__saveConfig(config);
    await Util.exec('wg-quick down wg0').catch(() => {});
    await Util.exec('wg-quick up wg0').catch((err) => {
      if (err && err.message && err.message.includes('Cannot find device "wg0"')) {
        throw new Error('WireGuard exited with the error: Cannot find device "wg0"\nThis usually means that your host\'s kernel does not support WireGuard!');
      }

      throw err;
    });
    await this.__syncConfig();
    await this.__syncClientIsolationFirewall(config);
    await this.__configureUplinkRouting(config);
    await this.__syncDnsRouting(config);

    this.__configPromise = config;
    return config;
  }

  async __getConfigUnlocked() {
    if (this.__configPromise) {
      return this.__configPromise;
    }

    return this.__initializeConfigUnlocked();
  }

  async getConfig() {
    if (this.__configPromise) {
      return this.__configPromise;
    }

    if (!this.__configInitializingPromise) {
      this.__configInitializingPromise = this.__runLifecycleExclusive(async () => {
        if (this.__configPromise) {
          return this.__configPromise;
        }

        return this.__initializeConfigUnlocked();
      }).finally(() => {
        this.__configInitializingPromise = null;
      });
    }

    return this.__configInitializingPromise;
  }

  async saveConfig() {
    return this.__runLifecycleExclusive(async () => {
      await this.__loadRuntimeSettings();
      const config = await this.__getConfigUnlocked();
      this.__pruneClientIsolationRules(config);
      this.__normalizeUplinkSettingsList(config);
      this.__normalizeClientUplinkAssignments(config);
      await this.__saveConfig(config);
      await this.__syncConfig();
      await this.__syncClientIsolationFirewall(config);
      await this.__syncUplinkRouting(config);
      await this.__syncDnsRouting(config);
      this.__configPromise = config;
      return config;
    });
  }

  async __saveConfig(config) {
    const runtime = await this.__loadRuntimeSettings();
    config.server.address = runtime.wgDefaultAddress.replace('x', '1');
    const postUp = this.__getRuntimePostUp(runtime);
    const postDown = this.__getRuntimePostDown(runtime);
    let result = `
# Note: Do not edit this file directly.
# Your changes will be overwritten!

# Server
[Interface]
PrivateKey = ${config.server.privateKey}
Address = ${config.server.address}/24
ListenPort = ${runtime.wgPort}
MTU = ${WG_MTU}
PreUp = ${WG_PRE_UP}
PostUp = ${postUp}
PreDown = ${WG_PRE_DOWN}
PostDown = ${postDown}
Jc = ${config.server.jc}
Jmin = ${config.server.jmin}
Jmax = ${config.server.jmax}
S1 = ${config.server.s1}
S2 = ${config.server.s2}
H1 = ${config.server.h1}
H2 = ${config.server.h2}
H3 = ${config.server.h3}
H4 = ${config.server.h4}
`;

    for (const [clientId, client] of Object.entries(config.clients)) {
      if (!client.enabled) continue;

      result += `

# Client: ${client.name} (${clientId})
[Peer]
PublicKey = ${client.publicKey}
${client.preSharedKey ? `PresharedKey = ${client.preSharedKey}\n` : ''
}AllowedIPs = ${client.address}/32`;
    }

    debug('Config saving...');
    await this.__configStore.setConfig(config);
    await fs.writeFile(path.join(WG_PATH, 'wg0.json'), JSON.stringify(config, false, 2), {
      mode: 0o660,
    });
    await fs.writeFile(path.join(WG_PATH, 'wg0.conf'), result, {
      mode: 0o600,
    });
    debug('Config saved.');
  }

  async __syncConfig() {
    debug('Config syncing...');
    await Util.exec('wg syncconf wg0 <(wg-quick strip wg0)');
    debug('Config synced.');
  }

  async getClients() {
    const config = await this.getConfig();
    const clients = Object.entries(config.clients).map(([clientId, client]) => ({
      id: clientId,
      name: client.name,
      enabled: client.enabled,
      address: client.address,
      aclGroups: Array.isArray(client.aclGroups) ? [...client.aclGroups] : [],
      publicKey: client.publicKey,
      createdAt: new Date(client.createdAt),
      updatedAt: new Date(client.updatedAt),
      expiredAt: client.expiredAt !== null
        ? new Date(client.expiredAt)
        : null,
      allowedIPs: client.allowedIPs,
      uplinkId: config.clientUplinkAssignments?.[clientId] || null,
      oneTimeLink: client.oneTimeLink ?? null,
      oneTimeLinkExpiresAt: client.oneTimeLinkExpiresAt ?? null,
      downloadableConfig: 'privateKey' in client,
      email: client.email || '',
      telegramId: client.telegramId || '',
      groups: Array.isArray(client.groups) ? [...client.groups] : [],
      persistentKeepalive: null,
      latestHandshakeAt: null,
      transferRx: null,
      transferTx: null,
      endpoint: null,
    }));

    // Loop WireGuard status
    try {
      const dump = await Util.exec('wg show wg0 dump', {
        log: false,
      });
      dump
        .trim()
        .split('\n')
        .slice(1)
        .forEach((line) => {
          const [
            publicKey,
            preSharedKey, // eslint-disable-line no-unused-vars
            endpoint, // eslint-disable-line no-unused-vars
            allowedIps, // eslint-disable-line no-unused-vars
            latestHandshakeAt,
            transferRx,
            transferTx,
            persistentKeepalive,
          ] = line.split('\t');

          const client = clients.find((client) => client.publicKey === publicKey);
          if (!client) return;

          client.latestHandshakeAt = latestHandshakeAt === '0'
            ? null
            : new Date(Number(`${latestHandshakeAt}000`));
          client.endpoint = endpoint === '(none)' ? null : endpoint;
          client.transferRx = Number(transferRx);
          client.transferTx = Number(transferTx);
          client.persistentKeepalive = persistentKeepalive;
        });
    } catch (err) {
      debug(`Failed to get WireGuard dump: ${err.message}`);
    }

    return clients;
  }

  async getClient({ clientId }) {
    const config = await this.getConfig();
    const client = config.clients[clientId];
    if (!client) {
      throw new ServerError(`Client Not Found: ${clientId}`, 404);
    }

    return client;
  }

  async getClientConfiguration({ clientId }) {
    const config = await this.getConfig();
    const client = await this.getClient({ clientId });
    const defaultDns = await this.__getConfiguredDefaultDns();
    const runtime = await this.__loadRuntimeSettings();
    const dnsRouting = this.__normalizeDnsRoutingSettings(config);
    const resolveCacheLoaded = dnsRouting.resolveEnabled
      && this.__resolveState.lastResolved !== null;
    // When pre-resolve cache is loaded, clients can use any DNS
    // because ipsets are pre-populated and routing works on IP level
    const clientDns = (dnsRouting.enabled && !resolveCacheLoaded)
      ? config.server.address
      : defaultDns;

    if (!this.__resolvedWgHost) {
      await this.__resolveWgHost({ required: true });
    }

    return `[Interface]
PrivateKey = ${client.privateKey ? `${client.privateKey}` : 'REPLACE_ME'}
Address = ${client.address}/24
${clientDns ? `DNS = ${clientDns}\n` : ''}\
${runtime.wgMtu ? `MTU = ${runtime.wgMtu}\n` : ''}\
Jc = ${config.server.jc}
Jmin = ${config.server.jmin}
Jmax = ${config.server.jmax}
S1 = ${config.server.s1}
S2 = ${config.server.s2}
H1 = ${config.server.h1}
H2 = ${config.server.h2}
H3 = ${config.server.h3}
H4 = ${config.server.h4}

[Peer]
PublicKey = ${config.server.publicKey}
${client.preSharedKey ? `PresharedKey = ${client.preSharedKey}\n` : ''
}AllowedIPs = ${runtime.wgAllowedIps}
PersistentKeepalive = ${runtime.wgPersistentKeepalive}
Endpoint = ${this.__resolvedWgHost}:${runtime.wgConfigPort}`;
  }

  async getClientQRCodeSVG({ clientId }) {
    const config = await this.getClientConfiguration({ clientId });
    try {
      return await QRCode.toString(config, {
        type: 'svg',
        width: 512,
      });
    } catch (err) {
      // Конфиг с крупной мимикрией (QUIC I1 ~1200 байт и т.п.) превышает
      // ёмкость QR-кода (~3KB) — отдаём понятную заглушку вместо 500.
      debug(`QR code generation failed for client ${clientId}: ${err.message}`);
      const message = 'QR unavailable: config too large (big CPS packets). Use .conf or .vpn download.';
      return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0f1117"/><text x="256" y="256" fill="#c94040" font-size="20" text-anchor="middle">${message}</text></svg>`;
    }
  }

  async getClientVpnKey({ clientId }) {
    const vpnConfig = await this.getClientVpnConfig({ clientId });
    // Формат vpn:// как в AmneziaVPN (exportController.cpp, qCompress) и конвертере
    // awg-vpn-uri: 4 байта BE размера несжатого JSON + zlib(JSON) → base64url без padding.
    // Клиент парсит: base64url → qUncompress (size+zlib), при неудаче — сырые байты.
    const json = Buffer.from(JSON.stringify(vpnConfig), 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(json.length, 0);
    const payload = Buffer.concat([size, zlib.deflateSync(json)]);
    return `vpn://${payload.toString('base64url')}`;
  }

  async getClientVpnConfig({ clientId }) {
    const config = await this.getConfig();
    const client = await this.getClient({ clientId });
    const clientConfig = await this.getClientConfiguration({ clientId });
    const defaultDns = await this.__getConfiguredDefaultDns();
    const runtime = await this.__loadRuntimeSettings();

    if (!this.__resolvedWgHost) {
      await this.__resolveWgHost({ required: true });
    }

    // Распарсим клиентский конфиг чтобы вытащить IP из Address
    const addrMatch = clientConfig.match(/^Address\s*=\s*(\S+)/m);
    const clientIp = addrMatch ? addrMatch[1].replace(/\/.*/, '') : (client.address || '');

    // Протокольная версия из env: 1.5, 2.0, 3.0
    const { AMNEZIA_VERSION } = require('../config');
    const hasCPS = AMNEZIA_VERSION === '2' || AMNEZIA_VERSION === '3';
    const isV3 = AMNEZIA_VERSION === '3';

    // v3-поля (HeaderProtectionKey — must-match; таймеры/padding — опциональные).
    // AmneziaVPN 5.0.0.5 читает их ТОЛЬКО из JSON last_config (парсер .conf их
    // отбрасывает — апстрим-баг amnezia-client#2942), поэтому кладём сюда.
    const v3fields = {
      HeaderProtectionKey: config.server.headerProtectionKey || '',
      ContentPaddingAddition: config.server.contentPaddingAddition || '',
      RekeyAfterTime: config.server.rekeyAfterTime || '',
      RekeyTimeout: config.server.rekeyTimeout || '',
      RejectAfterTime: config.server.rejectAfterTime || '',
      KeepaliveTimeout: config.server.keepaliveTimeout || '',
      MaxHandshakeAttempts: config.server.maxHandshakeAttempts || '',
    };
    const nonEmptyV3 = Object.fromEntries(
      Object.entries(v3fields).filter(([, v]) => v),
    );
    const hasV3Params = Object.keys(nonEmptyV3).length > 0;
    const containerName = isV3 && hasV3Params ? 'amnezia-awg' : (hasCPS ? 'amnezia-awg2' : 'amnezia-awg');

    // last_config: JSON-строка с полным конфигом (как в Amnezia backup)
    const lastConfig = JSON.stringify({
      client_priv_key: client.privateKey || '',
      client_pub_key: client.publicKey || '',
      clientId: client.publicKey || '',
      client_ip: client.address || '',
      server_pub_key: config.server.publicKey || '',
      psk_key: client.preSharedKey || '',
      hostName: this.__resolvedWgHost,
      port: parseInt(runtime.wgConfigPort, 10) || 51820,
      mtu: runtime.wgMtu || '1280',
      persistent_keep_alive: runtime.wgPersistentKeepalive || '25',
      dns: defaultDns || '1.1.1.1',
      Jc: String(config.server.jc || '3'),
      Jmin: String(config.server.jmin || '40'),
      Jmax: String(config.server.jmax || '80'),
      S1: String(config.server.s1 || '50'),
      S2: String(config.server.s2 || '50'),
      S3: config.server.s3 ? String(config.server.s3) : '0',
      S4: config.server.s4 ? String(config.server.s4) : '0',
      H1: String(config.server.h1 || ''),
      H2: String(config.server.h2 || ''),
      H3: String(config.server.h3 || ''),
      H4: String(config.server.h4 || ''),
      I1: config.server.i1 || '',
      I2: config.server.i2 || '',
      I3: config.server.i3 || '',
      I4: config.server.i4 || '',
      I5: config.server.i5 || '',
      ...nonEmptyV3,
      allowed_ips: ['0.0.0.0/0', '::/0'],
      config: clientConfig,
    });

    const parsedLC = JSON.parse(lastConfig);
    return {
      hostName: this.__resolvedWgHost,
      description: client.name || 'AmneziaWG',
      defaultContainer: containerName,
      userName: '',
      password: '',
      port: 22,
      containers: [
        {
          container: containerName,
          awg: {
            ...(hasV3Params ? { protocol_version: '3' } : {}),
            isThirdPartyConfig: true,
            H1: parsedLC.H1,
            H2: parsedLC.H2,
            H3: parsedLC.H3,
            H4: parsedLC.H4,
            Jc: parsedLC.Jc,
            Jmin: parsedLC.Jmin,
            Jmax: parsedLC.Jmax,
            S1: parsedLC.S1,
            S2: parsedLC.S2,
            ...(parsedLC.S3 !== '0' ? { S3: parsedLC.S3 } : {}),
            ...(parsedLC.S4 !== '0' ? { S4: parsedLC.S4 } : {}),
            ...(parsedLC.I1 ? { I1: parsedLC.I1 } : {}),
            ...(parsedLC.I2 ? { I2: parsedLC.I2 } : {}),
            ...(parsedLC.I3 ? { I3: parsedLC.I3 } : {}),
            ...(parsedLC.I4 ? { I4: parsedLC.I4 } : {}),
            ...(parsedLC.I5 ? { I5: parsedLC.I5 } : {}),
            last_config: lastConfig,
            port: String(parseInt(runtime.wgConfigPort, 10) || 51820),
            transport_proto: 'udp',
          },
        },
      ],
    };
  }

  async createClient({ name, expiredDate, email, telegramId, groups }) {
    const normalizedName = this.__normalizeClientName(name);
    const runtime = await this.__loadRuntimeSettings();

    const config = await this.getConfig();

    const privateKey = await Util.exec('wg genkey');
    const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
      log: 'echo ***hidden*** | wg pubkey',
    });
    const preSharedKey = await Util.exec('wg genpsk');

    // Calculate next IP
    let address;
    for (let i = 2; i < 255; i++) {
      const client = Object.values(config.clients).find((client) => {
        return client.address === runtime.wgDefaultAddress.replace('x', i);
      });

      if (!client) {
        address = runtime.wgDefaultAddress.replace('x', i);
        break;
      }
    }

    if (!address) {
      throw new Error('Maximum number of clients reached.');
    }
    // Create Client
    const id = crypto.randomUUID();
    const client = {
      id,
      name: normalizedName,
      address,
      aclGroups: [],
      privateKey,
      publicKey,
      preSharedKey,

      createdAt: new Date(),
      updatedAt: new Date(),
      expiredAt: null,
      enabled: true,
      email: typeof email === 'string' ? email.trim() : '',
      telegramId: typeof telegramId === 'string' ? telegramId.trim() : '',
      groups: Array.isArray(groups) ? groups.filter((g) => typeof g === 'string' && g.trim()) : [],
    };
    if (expiredDate) {
      client.expiredAt = new Date(expiredDate);
    }
    config.clients[id] = client;

    await this.saveConfig();

    return client;
  }

  async deleteClient({ clientId }) {
    const config = await this.getConfig();

    if (config.clients[clientId]) {
      delete config.clients[clientId];
      await this.saveConfig();
    }
  }

  async enableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = true;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async generateOneTimeLink({ clientId }) {
    const client = await this.getClient({ clientId });
    client.oneTimeLink = crypto.randomBytes(24).toString('base64url');
    client.oneTimeLinkExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    client.updatedAt = new Date();
    await this.saveConfig();
  }

  async eraseOneTimeLink({ clientId }) {
    const client = await this.getClient({ clientId });
    client.oneTimeLink = null;
    client.oneTimeLinkExpiresAt = null;
    client.updatedAt = new Date();
    await this.saveConfig();
  }

  async disableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = false;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientName({ clientId, name }) {
    const client = await this.getClient({ clientId });

    client.name = this.__normalizeClientName(name);
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientAddress({ clientId, address }) {
    const client = await this.getClient({ clientId });

    if (!Util.isValidIPv4(address)) {
      throw new ServerError(`Invalid Address: ${address}`, 400);
    }

    client.address = address;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientAclGroups({ clientId, aclGroups }) {
    const client = await this.getClient({ clientId });
    client.aclGroups = Array.isArray(aclGroups)
      ? aclGroups
      : typeof aclGroups === 'string'
        ? aclGroups.split(/[,\n;]+/)
        : [];
    this.__normalizeClientAclGroups(client);
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientExpireDate({ clientId, expireDate }) {
    const client = await this.getClient({ clientId });

    if (expireDate) {
      client.expiredAt = new Date(expireDate);
    } else {
      client.expiredAt = null;
    }
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientEmail({ clientId, email }) {
    const client = await this.getClient({ clientId });
    client.email = typeof email === 'string' ? email.trim() : '';
    client.updatedAt = new Date();
    await this.saveConfig();
  }

  async updateClientTelegramId({ clientId, telegramId }) {
    const client = await this.getClient({ clientId });
    client.telegramId = typeof telegramId === 'string' ? telegramId.trim() : '';
    client.updatedAt = new Date();
    await this.saveConfig();
  }

  async updateClientGroups({ clientId, groups }) {
    const client = await this.getClient({ clientId });
    if (Array.isArray(groups)) {
      client.groups = groups.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim());
    } else if (typeof groups === 'string') {
      client.groups = groups.split(/[,\n;]+/).map((g) => g.trim()).filter(Boolean);
    } else {
      client.groups = [];
    }
    client.updatedAt = new Date();
    await this.saveConfig();
  }

  async getClientIsolationSettings() {
    const config = await this.getConfig();
    const isolation = this.__pruneClientIsolationRules(config);
    const availableGroups = [...new Set(
      Object.values(config.clients)
        .flatMap((client) => Array.isArray(client.aclGroups) ? client.aclGroups : [])
        .filter(Boolean)
    )].sort((left, right) => left.localeCompare(right));

    return {
      enabled: isolation.enabled,
      availableGroups,
      rules: isolation.rules.map((rule) => ({
        ...rule,
      })),
    };
  }

  async getUplinkSettings() {
    const config = await this.getConfig();
    const uplink = this.__getEffectiveUplinkSettings(config, this.__normalizeUplinkSettings(config));

    return {
      id: uplink.id,
      name: uplink.name,
      enabled: uplink.enabled,
      configPath: uplink.configPath,
      interfaceName: uplink.interfaceName,
      table: uplink.table,
      geoSiteSync: uplink.geoSiteSync === true,
      geoIpSync: uplink.geoIpSync === true,
      sourceRules: [...uplink.sourceRules],
      destinationIps: [...uplink.destinationIps],
      destinationDomains: [...uplink.destinationDomains],
    };
  }

  async getUplinkSettingsList() {
    const config = await this.getConfig();
    const uplinks = this.__normalizeUplinkSettingsList(config)
      .map((uplink) => this.__getEffectiveUplinkSettings(config, uplink));

    return uplinks.map((uplink) => ({
      id: uplink.id,
      name: uplink.name,
      enabled: uplink.enabled,
      configPath: uplink.configPath,
      interfaceName: uplink.interfaceName,
      table: uplink.table,
      geoSiteSync: uplink.geoSiteSync === true,
      geoIpSync: uplink.geoIpSync === true,
      sourceRules: [...uplink.sourceRules],
      destinationIps: [...uplink.destinationIps],
      destinationDomains: [...uplink.destinationDomains],
    }));
  }

  async getClientUplinkAssignment(clientId) {
    const config = await this.getConfig();
    this.__normalizeClientUplinkAssignments(config);

    return config.clientUplinkAssignments[clientId] === 'main'
      ? null
      : (config.clientUplinkAssignments[clientId] || null);
  }

  async setClientUplinkAssignment({
    clientId,
    uplinkId = null,
  }) {
    const config = await this.getConfig();
    if (!config.clients[clientId]) {
      throw new ServerError(`Client not found: ${clientId}`, 404);
    }

    this.__normalizeUplinkSettingsList(config);
    this.__normalizeClientUplinkAssignments(config);

    if (uplinkId === null || uplinkId === '' || uplinkId === 'main') {
      config.clientUplinkAssignments[clientId] = 'main';
    } else {
      const uplink = config.uplinks.find((candidate) => candidate.id === uplinkId);
      if (!uplink) {
        throw new ServerError(`Uplink not found: ${uplinkId}`, 404);
      }

      config.clientUplinkAssignments[clientId] = uplinkId;
    }

    await this.saveConfig();

    return {
      clientId,
      uplinkId: config.clientUplinkAssignments[clientId] === 'main'
        ? null
        : (config.clientUplinkAssignments[clientId] || null),
    };
  }

  async getRoutingCategories() {
    const config = await this.getConfig();
    const categories = this.__validateRoutingCategories(config);

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      enabled: category.enabled,
      uplinkId: category.uplinkId,
      domains: [...category.domains],
    }));
  }

  async updateRoutingCategories({ categories }) {
    const config = await this.getConfig();
    this.__normalizeUplinkSettingsList(config);

    const inputCategories = Array.isArray(categories) ? categories : [];
    config.routingCategories = inputCategories.map((category, index) => ({
      id: typeof category?.id === 'string' && category.id.trim() ? category.id.trim() : crypto.randomUUID(),
      name: typeof category?.name === 'string' && category.name.trim() ? category.name.trim() : `Category ${index + 1}`,
      enabled: category?.enabled !== false,
      uplinkId: typeof category?.uplinkId === 'string' && category.uplinkId.trim() ? category.uplinkId.trim() : null,
      domains: Array.isArray(category?.domains)
        ? category.domains
        : typeof category?.domains === 'string'
          ? category.domains.split(/[\n,;]+/)
          : [],
    }));

    this.__validateRoutingCategories(config);
    this.__normalizeClientRoutingCategoryAssignments(config);
    await this.saveConfig();
    return this.getRoutingCategories();
  }

  async getClientRoutingCategories(clientId) {
    const config = await this.getConfig();
    if (!config.clients[clientId]) {
      throw new ServerError(`Client not found: ${clientId}`, 404);
    }

    const categories = this.__validateRoutingCategories(config);
    const assignments = this.__normalizeClientRoutingCategoryAssignments(config);
    const enabledCategoryIds = new Set(assignments[clientId] || []);

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      enabled: category.enabled,
      uplinkId: category.uplinkId,
      domains: [...category.domains],
      active: enabledCategoryIds.has(category.id),
    }));
  }

  async toggleClientRoutingCategory({
    clientId,
    categoryId,
    enabled,
  }) {
    const config = await this.getConfig();
    if (!config.clients[clientId]) {
      throw new ServerError(`Client not found: ${clientId}`, 404);
    }

    const categories = this.__validateRoutingCategories(config);
    const category = categories.find((candidate) => candidate.id === categoryId);
    if (!category) {
      throw new ServerError(`Routing category not found: ${categoryId}`, 404);
    }

    this.__normalizeClientRoutingCategoryAssignments(config);
    const assigned = new Set(config.clientRoutingCategories[clientId] || []);
    if (enabled) {
      assigned.add(categoryId);
    } else {
      assigned.delete(categoryId);
    }

    if (assigned.size > 0) {
      config.clientRoutingCategories[clientId] = [...assigned];
    } else {
      delete config.clientRoutingCategories[clientId];
    }

    await this.saveConfig();
    return this.getClientRoutingCategories(clientId);
  }

  async getDnsRoutingSettings() {
    const config = await this.getConfig();
    const dnsRouting = this.__normalizeDnsRoutingSettings(config);

    return {
      enabled: dnsRouting.enabled,
      resolveEnabled: dnsRouting.resolveEnabled,
      upstreams: [...dnsRouting.upstreams],
      listenAddress: config.server.address,
    };
  }

  async getDnsQueryLogs({
    limit = 200,
  } = {}) {
    const config = await this.getConfig();
    const dnsRouting = this.__normalizeDnsRoutingSettings(config);
    const { logPath } = this.__getDnsRoutingPaths();
    const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 200));

    const lines = await Util.exec(`tail -n ${safeLimit} ${this.__escapeShellArgument(logPath)}`, {
      log: false,
    }).then((stdout) => stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean))
      .catch(() => []);

    const stats = await fs.stat(logPath).catch(() => null);

    return {
      enabled: dnsRouting.enabled,
      logPath,
      lines,
      updatedAt: stats ? new Date(stats.mtimeMs).toISOString() : null,
    };
  }

  async testUplinkConnection({ uplinkId = null } = {}) {
    const config = await this.getConfig();
    const uplinkSettings = this.__validateUplinkSettingsList(this.__normalizeUplinkSettingsList(config));
    const selectedSettings = uplinkId
      ? uplinkSettings.find((candidate) => candidate.id === uplinkId)
      : uplinkSettings[0];

    if (!selectedSettings) {
      throw new ServerError(uplinkId ? 'Requested uplink was not found.' : 'Uplink is not configured.', 400);
    }

    const uplink = await this.__getValidatedUplinkConfig({
      ...config,
      uplink: { ...selectedSettings, enabled: true },
      uplinks: [{ ...selectedSettings, enabled: true }],
    });

    const runtimeUplinks = Array.isArray(this.__uplinkRuntime) ? this.__uplinkRuntime : [];
    const currentlyManaged = runtimeUplinks.some((candidate) => this.__isSameUplinkConfig(candidate, uplink));
    let startedForTest = false;

    try {
      if (!currentlyManaged) {
        await Util.exec(`wg-quick down ${uplink.interfaceName}`, {
          log: false,
        }).catch(() => {});
        await this.__bringUpUplinkInterface(uplink);
        startedForTest = true;
      }

      const sourceAddress = await this.__getInterfaceIpv4Address(uplink.interfaceName);
      if (!sourceAddress) {
        throw new ServerError(`Unable to determine IPv4 address of ${uplink.interfaceName}.`, 400);
      }

      const probe = await this.__runUplinkProbe(uplink.interfaceName, sourceAddress);
      const peerState = await this.__getUplinkPeerState(uplink.interfaceName);
      const freshHandshake = Boolean(
        peerState.latestHandshakeAt
        && (Date.now() - peerState.latestHandshakeAt.getTime() <= 30000)
      );

      if (!probe.connected && !freshHandshake) {
        throw new ServerError(`Uplink test failed: ${probe.error || 'No fresh handshake detected.'}`, 400);
      }

      return {
        success: true,
        interfaceName: uplink.interfaceName,
        sourceAddress,
        connected: probe.connected,
        latestHandshakeAt: peerState.latestHandshakeAt ? peerState.latestHandshakeAt.toISOString() : null,
        endpoint: peerState.endpoint || null,
        transferRx: peerState.transferRx,
        transferTx: peerState.transferTx,
        message: freshHandshake
          ? `Uplink test succeeded: fresh handshake detected on ${uplink.interfaceName}.`
          : `Uplink probe connected successfully through ${uplink.interfaceName}.`,
      };
    } finally {
      if (startedForTest) {
        await Util.exec(`wg-quick down ${uplink.interfaceName}`, {
          log: false,
        }).catch(() => {});
      }
    }
  }

  async updateClientIsolationSettings({
    enabled,
    rules,
  }) {
    const config = await this.getConfig();
    const isolation = this.__normalizeClientIsolation(config);

    isolation.enabled = enabled === true;
    isolation.rules = Array.isArray(rules)
      ? rules.map((rule) => this.__validateClientIsolationRule(rule, config.clients))
      : [];

    await this.saveConfig();

    return this.getClientIsolationSettings();
  }

  async getUplinkProtectedCidrs() {
    const config = await this.getConfig();

    return {
      cidrs: [...this.__normalizeUplinkProtectedCidrs(config)],
    };
  }

  async updateUplinkProtectedCidrs({
    cidrs,
  }) {
    const config = await this.getConfig();
    config.uplinkProtectedCidrs = Array.isArray(cidrs)
      ? cidrs
      : typeof cidrs === 'string'
        ? cidrs.split(/[\n,;]+/)
        : [];

    this.__normalizeUplinkProtectedCidrs(config);
    await this.saveConfig();
    return this.getUplinkProtectedCidrs();
  }

  async updateUplinkSettings({
    id,
    name,
    enabled,
    configPath,
    interfaceName,
    table,
    sourceRules,
    destinationDomains,
    destinationIps,
    geoSiteSync,
    geoIpSync,
  }) {
    const config = await this.getConfig();
    const validatedSettings = this.__validateUplinkSettings({
      id,
      name,
      enabled,
      configPath,
      interfaceName,
      table,
      geoSiteSync,
      geoIpSync,
      sourceRules: Array.isArray(sourceRules)
        ? sourceRules
        : typeof sourceRules === 'string'
          ? sourceRules.split(/[\n,;]+/)
          : [],
      destinationIps: Array.isArray(destinationIps)
        ? destinationIps
        : typeof destinationIps === 'string'
          ? destinationIps.split(/[\n,;]+/)
          : [],
      destinationDomains: Array.isArray(destinationDomains)
        ? destinationDomains
        : typeof destinationDomains === 'string'
          ? destinationDomains.split(/[\n,;]+/)
          : [],
    });

    if (validatedSettings.enabled) {
      await this.__getValidatedUplinkConfig({
        ...config,
        uplink: validatedSettings,
        uplinks: [validatedSettings],
      });
    }

    config.uplinks = [validatedSettings];
    config.uplink = validatedSettings;
    await this.saveConfig();
    await this.__syncUplinkRouting(config);
    return this.getUplinkSettings();
  }

  async updateUplinkSettingsList({ uplinks }) {
    const config = await this.getConfig();
    const validatedUplinks = this.__validateUplinkSettingsList(Array.isArray(uplinks) ? uplinks : []);

    if (validatedUplinks.some((uplink) => uplink.enabled)) {
      await this.__getValidatedUplinkConfigs({
        ...config,
        uplinks: validatedUplinks,
        uplink: validatedUplinks[0] || this.__getDefaultUplinkSettings(),
      });
    }

    config.uplinks = validatedUplinks;
    config.uplink = validatedUplinks.length > 0
      ? { ...validatedUplinks[0] }
      : this.__getEmptyUplinkSettings();
    await this.saveConfig();
    await this.__syncUplinkRouting(config);
    return this.getUplinkSettingsList();
  }

  async updateDnsRoutingSettings({
    enabled,
    resolveEnabled,
    upstreams,
  }) {
    const config = await this.getConfig();
    config.dnsRouting = this.__validateDnsRoutingSettings({
      enabled,
      resolveEnabled,
      upstreams: Array.isArray(upstreams)
        ? upstreams
        : typeof upstreams === 'string'
          ? upstreams.split(/[\s,\n;]+/)
          : [],
    });

    await this.saveConfig();

    // Auto-start DNS pre-resolve when enabled and no cache exists
    if (resolveEnabled && !this.__resolveState.lastResolved) {
      const cachePath = this.__getDnsResolveCachePath();
      try {
        require('fs').accessSync(cachePath);
      } catch {
        // No cache file — start resolve in background
        this.startDnsResolve().catch((err) => {
          debug(`Auto-start DNS resolve failed: ${err.message}`);
        });
      }
    }

    return this.getDnsRoutingSettings();
  }

  getDnsResolveStatus() {
    const cachePath = this.__getDnsResolveCachePath();
    let cacheInfo = null;
    try {
      const raw = require('fs').readFileSync(cachePath, 'utf8');
      const cache = JSON.parse(raw);
      cacheInfo = {
        updatedAt: cache.updatedAt || null,
        totalDomains: cache.totalDomains || 0,
      };
    } catch {
      // cache file doesn't exist or is invalid
    }

    // Read lastResolved from cache file (persists across restarts)
    let lastResolved = this.__resolveState.lastResolved;
    if (!lastResolved && cacheInfo && cacheInfo.updatedAt) {
      lastResolved = cacheInfo.updatedAt;
      this.__resolveState.lastResolved = lastResolved;
    }

    return {
      running: this.__resolveState.running,
      total: this.__resolveState.total,
      processed: this.__resolveState.processed,
      errors: this.__resolveState.errors,
      startedAt: this.__resolveState.startedAt,
      eta: this.__resolveState.eta,
      lastResolved,
      cache: cacheInfo,
    };
  }

  async startDnsResolve() {
    if (this.__resolveState.running) {
      throw new ServerError('DNS resolve is already in progress.', 409);
    }

    const config = await this.getConfig();

    // Collect all domains grouped by their ipset name
    const domainMap = new Map(); // domain -> { setName, category }

    const uplinks = this.__normalizeUplinkSettingsList(config);
    for (const uplink of uplinks) {
      if (!Array.isArray(uplink.destinationDomains) || uplink.destinationDomains.length === 0) continue;
      const setName = this.__getUplinkDomainSetName(uplink);
      for (const domain of uplink.destinationDomains) {
        if (!domainMap.has(domain)) {
          domainMap.set(domain, { setName });
        }
      }
    }

    const routingCategories = Array.isArray(config.routingCategories) ? config.routingCategories : [];
    for (const category of routingCategories) {
      if (!Array.isArray(category.domains) || category.domains.length === 0) continue;
      const setName = this.__getRoutingCategorySetName(category);
      for (const domain of category.domains) {
        if (!domainMap.has(domain)) {
          domainMap.set(domain, { setName });
        }
      }
    }

    // Collect bypass GeoSite domains
    if (WG_BYPASS_ENABLED) {
      const geoSiteCategories = (WG_BYPASS_GEOSITE || '').split(',').map(s => s.trim()).filter(Boolean);
      const bypassSetName = 'awg_bypass_domain';
      for (const cat of geoSiteCategories) {
        const geoSiteFile = `/app/bypass/geosite/${cat}.txt`;
        try {
          const data = require('fs').readFileSync(geoSiteFile, 'utf8');
          const lines = data.split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('include:'));
          for (const domain of lines) {
            const d = domain.trim();
            if (d && !domainMap.has(d)) {
              domainMap.set(d, { setName: bypassSetName });
            }
          }
        } catch { /* file not found */ }
      }
      const bypassDomains = (WG_BYPASS_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const domain of bypassDomains) {
        if (domain && !domainMap.has(domain)) {
          domainMap.set(domain, { setName: bypassSetName });
        }
      }
    }

    if (domainMap.size === 0) {
      throw new ServerError('No domains configured for resolution.', 400);
    }

    // Compare with cached domains — skip if unchanged
    const cachePath = this.__getDnsResolveCachePath();
    try {
      const cached = JSON.parse(require('fs').readFileSync(cachePath, 'utf8'));
      const cachedDomains = Object.keys(cached.entries || {});
      const currentDomains = [...domainMap.keys()].sort();
      const cachedSorted = [...cachedDomains].sort();
      if (currentDomains.length === cachedSorted.length
          && currentDomains.every((d, i) => d === cachedSorted[i])) {
        return {
          total: currentDomains.length,
          cached: true,
          message: 'All domains are already resolved.',
        };
      }
    } catch { /* no cache or invalid — proceed with resolve */ }

    const domains = [...domainMap.keys()];
    const entries = Object.create(null);

    this.__resolveState = {
      running: true,
      total: domains.length,
      processed: 0,
      errors: 0,
      startedAt: new Date().toISOString(),
      eta: null,
      lastResolved: this.__resolveState.lastResolved,
    };

    // Run in background — don't block the API response
    (async () => {
      const startTime = Date.now();
      const BATCH_SIZE = 10;
      const BATCH_DELAY_MS = 50;

      try {
        for (let i = 0; i < domains.length; i += BATCH_SIZE) {
          const batch = domains.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map((domain) => dns.resolve4(domain).then(
              (ips) => ({ domain, ips }),
              (err) => ({ domain, ips: [], error: err.message }),
            ))
          );

          for (const result of results) {
            if (result.status === 'fulfilled') {
              const { domain, ips, error } = result.value;
              if (error) {
                this.__resolveState.errors++;
                this.__resolveState.processed++;
                continue;
              }
              const validIps = ips.filter((ip) => Util.isValidIPv4(ip));
              if (validIps.length > 0) {
                const { setName } = domainMap.get(domain);
                entries[domain] = { ips: validIps, setName };

                // Add to ipset immediately
                for (const ip of validIps) {
                  try {
                    await Util.exec(`ipset add ${setName} ${ip} -exist`, { log: false });
                  } catch { /* ipset may not exist yet — will be populated by sync */ }
                }
              }
              this.__resolveState.processed++;
            } else {
              this.__resolveState.processed++;
              this.__resolveState.errors++;
            }
          }

          // Update ETA
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = this.__resolveState.processed / elapsed;
          const remaining = domains.length - this.__resolveState.processed;
          if (rate > 0 && remaining > 0) {
            const etaSeconds = Math.round(remaining / rate);
            const min = Math.floor(etaSeconds / 60);
            const sec = etaSeconds % 60;
            this.__resolveState.eta = `${min}:${String(sec).padStart(2, '0')}`;
          }

          // Delay between batches to avoid flooding upstream DNS
          if (i + BATCH_SIZE < domains.length) {
            await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
          }
        }

        // Write cache file
        const cache = {
          version: 1,
          updatedAt: new Date().toISOString(),
          totalDomains: domains.length,
          entries,
        };
        await fs.writeFile(this.__getDnsResolveCachePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
        this.__resolveState.lastResolved = cache.updatedAt;
      } catch (err) {
        debug(`DNS resolve failed: ${err.message}`);
      } finally {
        this.__resolveState.running = false;
        this.__resolveState.startedAt = null;
        this.__resolveState.eta = null;
      }
    })();

    return { success: true, total: domains.length };
  }

  async loadResolveCache() {
    const cachePath = this.__getDnsResolveCachePath();
    let cache;
    try {
      cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    } catch {
      debug('No DNS resolve cache found, skipping load.');
      return { loaded: false, total: 0 };
    }

    if (!cache.entries || typeof cache.entries !== 'object') {
      return { loaded: false, total: 0 };
    }

    let loaded = 0;
    for (const [domain, entry] of Object.entries(cache.entries)) {
      if (!entry || !Array.isArray(entry.ips) || !entry.setName) continue;
      for (const ip of entry.ips) {
        try {
          await Util.exec(`ipset add ${entry.setName} ${ip} -exist`, { log: false });
        } catch { /* ipset may not exist yet */ }
      }
      loaded++;
    }

    this.__resolveState.lastResolved = cache.updatedAt || null;
    debug(`Loaded ${loaded} domains from DNS resolve cache.`);
    return { loaded: true, total: loaded };
  }

  async __reloadConfig() {
    return this.__runLifecycleExclusive(async () => {
      const config = await this.__buildConfig();
      this.__configPromise = config;
      await this.__syncConfig();
      await this.__syncClientIsolationFirewall(config);

      // Load DNS resolve cache before routing sync — so ipsets are pre-populated
      const dnsRouting = this.__normalizeDnsRoutingSettings(config);
      if (dnsRouting.resolveEnabled) {
        await this.loadResolveCache().catch((err) => {
          debug(`Failed to load DNS resolve cache: ${err.message}`);
        });
      }

      await this.__syncUplinkRouting(config);

      // Auto-sync GeoSite domains for uplinks with geoSiteSync enabled
      this.syncGeoSiteToUplinks().catch((err) => {
        debug(`GeoSite auto-sync failed: ${err.message}`);
      });

      // Start GeoSite cron (twice a week = every 3.5 days)
      this.__startGeoSiteCron();

      return config;
    });
  }

  __startGeoSiteCron() {
    if (this.__geoSiteCronTimer) return; // already running
    const CRON_INTERVAL_MS = 302400000; // 3.5 days
    this.__geoSiteCronTimer = setInterval(() => {
      debug('GeoSite cron: checking for updates...');
      this.syncGeoSiteToUplinks().catch((err) => {
        debug(`GeoSite cron sync failed: ${err.message}`);
      });
    }, CRON_INTERVAL_MS);
    if (this.__geoSiteCronTimer.unref) {
      this.__geoSiteCronTimer.unref(); // don't keep process alive just for cron
    }
  }

  async restoreConfiguration(config) {
    debug('Starting configuration restore process.');
    return this.__runLifecycleExclusive(async () => {
      const _config = JSON.parse(config);
      this.__assertValidRestoreConfig(_config);
      await this.__saveConfig(_config);
      this.__configPromise = _config;
      await this.__reloadConfig();
      debug('Configuration restore process completed.');
    });
  }

  async backupConfiguration() {
    debug('Starting configuration backup.');
    const config = await this.getConfig();
    const backup = JSON.stringify(config, null, 2);
    debug('Configuration backup completed.');
    return backup;
  }

  // Shutdown wireguard
  async Shutdown() {
    return this.__runLifecycleExclusive(async () => {
      await this.__stopDnsRouting().catch((err) => {
        debug(`Failed to stop VPN DNS routing: ${err.message}`);
      });
      await this.__teardownUplinkRouting().catch((err) => {
        debug(`Failed to tear down uplink routing: ${err.message}`);
      });
      await Util.exec('wg-quick down wg0').catch(() => {});
    });
  }

  async cronJobEveryMinute() {
    const runtime = await this.__loadRuntimeSettings();
    const config = await this.getConfig();
    let needSaveConfig = false;

    await this.__refreshRuntimeUplinkDomains();

    // Expires Feature
    if (runtime.enableExpireTime) {
      for (const client of Object.values(config.clients)) {
        if (client.enabled !== true) continue;
        if (client.expiredAt !== null && new Date() > new Date(client.expiredAt)) {
          debug(`Client ${client.id} expired.`);
          needSaveConfig = true;
          client.enabled = false;
          client.updatedAt = new Date();
        }
      }
    }
    // One Time Link Feature
    if (runtime.enableOneTimeLinks) {
      for (const client of Object.values(config.clients)) {
        if (client.oneTimeLink !== null && new Date() > new Date(client.oneTimeLinkExpiresAt)) {
          debug(`Client ${client.id} One Time Link expired.`);
          needSaveConfig = true;
          client.oneTimeLink = null;
          client.oneTimeLinkExpiresAt = null;
          client.updatedAt = new Date();
        }
      }
    }
    if (needSaveConfig) {
      await this.saveConfig();
    }
  }

  async getMetrics() {
    const runtime = await this.__loadRuntimeSettings();
    const clients = await this.getClients();
    let wireguardPeerCount = 0;
    let wireguardEnabledPeersCount = 0;
    let wireguardConnectedPeersCount = 0;
    let wireguardSentBytes = '';
    let wireguardReceivedBytes = '';
    let wireguardLatestHandshakeSeconds = '';
    for (const client of Object.values(clients)) {
      wireguardPeerCount++;
      if (client.enabled === true) {
        wireguardEnabledPeersCount++;
      }
      if (client.endpoint !== null) {
        wireguardConnectedPeersCount++;
      }
      const escapedAddress = this.__escapePrometheusLabelValue(client.address);
      const escapedName = this.__escapePrometheusLabelValue(client.name);
      wireguardSentBytes += `wireguard_sent_bytes{interface="wg0",enabled="${client.enabled}",address="${escapedAddress}",name="${escapedName}"} ${Number(client.transferTx)}\n`;
      wireguardReceivedBytes += `wireguard_received_bytes{interface="wg0",enabled="${client.enabled}",address="${escapedAddress}",name="${escapedName}"} ${Number(client.transferRx)}\n`;
      wireguardLatestHandshakeSeconds += `wireguard_latest_handshake_seconds{interface="wg0",enabled="${client.enabled}",address="${escapedAddress}",name="${escapedName}"} ${client.latestHandshakeAt ? (new Date().getTime() - new Date(client.latestHandshakeAt).getTime()) / 1000 : 0}\n`;
    }

    let returnText = '# HELP wg-easy and wireguard metrics\n';

    returnText += '\n# HELP wireguard_configured_peers\n';
    returnText += '# TYPE wireguard_configured_peers gauge\n';
    returnText += `wireguard_configured_peers{interface="wg0"} ${Number(wireguardPeerCount)}\n`;

    returnText += '\n# HELP wireguard_enabled_peers\n';
    returnText += '# TYPE wireguard_enabled_peers gauge\n';
    returnText += `wireguard_enabled_peers{interface="wg0"} ${Number(wireguardEnabledPeersCount)}\n`;

    returnText += '\n# HELP wireguard_connected_peers\n';
    returnText += '# TYPE wireguard_connected_peers gauge\n';
    returnText += `wireguard_connected_peers{interface="wg0"} ${Number(wireguardConnectedPeersCount)}\n`;

    returnText += '\n# HELP wireguard_sent_bytes Bytes sent to the peer\n';
    returnText += '# TYPE wireguard_sent_bytes counter\n';
    returnText += `${wireguardSentBytes}`;

    returnText += '\n# HELP wireguard_received_bytes Bytes received from the peer\n';
    returnText += '# TYPE wireguard_received_bytes counter\n';
    returnText += `${wireguardReceivedBytes}`;

    returnText += '\n# HELP wireguard_latest_handshake_seconds UNIX timestamp seconds of the last handshake\n';
    returnText += '# TYPE wireguard_latest_handshake_seconds gauge\n';
    returnText += `${wireguardLatestHandshakeSeconds}`;

    return returnText;
  }

  async getMetricsJSON() {
    const clients = await this.getClients();
    let wireguardPeerCount = 0;
    let wireguardEnabledPeersCount = 0;
    let wireguardConnectedPeersCount = 0;
    const latestClients = this.__trafficHistory.getLatestClients();
    const latestByClientId = new Map(latestClients.map((client) => [client.clientId, client]));
    for (const client of Object.values(clients)) {
      wireguardPeerCount++;
      if (client.enabled === true) {
        wireguardEnabledPeersCount++;
      }
      if (client.endpoint !== null) {
        wireguardConnectedPeersCount++;
      }
    }
    return {
      wireguard_configured_peers: Number(wireguardPeerCount),
      wireguard_enabled_peers: Number(wireguardEnabledPeersCount),
      wireguard_connected_peers: Number(wireguardConnectedPeersCount),
      traffic_history_enabled: this.__trafficSamplerEnabled,
      traffic_sample_interval_seconds: runtime.trafficSampleIntervalSeconds,
      clients: clients.map((client) => {
        const latest = latestByClientId.get(client.id);
        return {
          id: client.id,
          name: client.name,
          address: client.address,
          enabled: client.enabled,
          connected: client.endpoint !== null,
          sent_bytes: Number(client.transferTx || 0),
          received_bytes: Number(client.transferRx || 0),
          latest_handshake_seconds: client.latestHandshakeAt
            ? (new Date().getTime() - new Date(client.latestHandshakeAt).getTime()) / 1000
            : 0,
          tx_bytes_per_second: latest ? latest.txRate : null,
          rx_bytes_per_second: latest ? latest.rxRate : null,
          sampled_at: latest ? new Date(latest.ts).toISOString() : null,
        };
      }),
    };
  }

  async getTrafficOverview() {
    const runtime = await this.__loadRuntimeSettings();
    return {
      enabled: this.__trafficSamplerEnabled,
      sampleIntervalSeconds: runtime.trafficSampleIntervalSeconds,
      rawRetentionHours: runtime.trafficRawRetentionHours,
      minuteRetentionDays: runtime.trafficMinuteRetentionDays,
      hourRetentionDays: runtime.trafficHourRetentionDays,
      clients: this.__trafficHistory.getLatestClients().map((client) => ({
        ...client,
        sampledAt: new Date(client.ts).toISOString(),
      })),
    };
  }

  async getClientTrafficHistory({
    clientId,
    period = 'day',
  }) {
    await this.getClient({ clientId });

    if (!this.__trafficSamplerEnabled) {
      throw new ServerError('Traffic history is disabled', 400);
    }

    if (!['day', 'week', 'month'].includes(period)) {
      throw new ServerError(`Unsupported traffic period: ${period}`, 400);
    }

    return this.__trafficHistory.getClientHistory({
      clientId,
      period,
    });
  }

};
