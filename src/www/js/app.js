/* eslint-disable no-console */
/* eslint-disable no-alert */
/* eslint-disable no-undef */
/* eslint-disable no-new */

'use strict';

function bytes(bytes, decimals, kib, maxunit) {
  kib = kib || false;
  if (bytes === 0) return '0 B';
  if (Number.isNaN(parseFloat(bytes)) && !Number.isFinite(bytes)) return 'NaN';
  const k = kib ? 1024 : 1000;
  const dm = decimals != null && !Number.isNaN(decimals) && decimals >= 0 ? decimals : 2;
  const sizes = kib
    ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB', 'BiB']
    : ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB', 'BB'];
  let i = Math.floor(Math.log(bytes) / Math.log(k));
  if (maxunit !== undefined) {
    const index = sizes.indexOf(maxunit);
    if (index !== -1) i = index;
  }
  // eslint-disable-next-line no-restricted-properties
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Sorts an array of objects by a specified property in ascending or descending order.
 *
 * @param {Array} array - The array of objects to be sorted.
 * @param {string} property - The property to sort the array by.
 * @param {boolean} [sort=true] - Whether to sort the array in ascending (default) or descending order.
 * @return {Array} - The sorted array of objects.
 */
function sortByProperty(array, property, sort = true) {
  if (sort) {
    return array.sort((a, b) => (typeof a[property] === 'string' ? a[property].localeCompare(b[property]) : a[property] - b[property]));
  }

  return array.sort((a, b) => (typeof a[property] === 'string' ? b[property].localeCompare(a[property]) : b[property] - a[property]));
}

const i18n = new VueI18n({
  locale: localStorage.getItem('lang') || 'en',
  fallbackLocale: 'en',
  messages,
});

const UI_CHART_TYPES = [
  { type: false, strokeWidth: 0 },
  { type: 'line', strokeWidth: 3 },
  { type: 'area', strokeWidth: 0 },
  { type: 'bar', strokeWidth: 0 },
];

const CHART_COLORS = {
  rx: { light: 'rgba(128,128,128,0.3)', dark: 'rgba(255,255,255,0.3)' },
  tx: { light: 'rgba(128,128,128,0.4)', dark: 'rgba(255,255,255,0.3)' },
  gradient: { light: ['rgba(0,0,0,1.0)', 'rgba(0,0,0,1.0)'], dark: ['rgba(128,128,128,0)', 'rgba(128,128,128,0)'] },
};

const TRAFFIC_PERIODS = ['day', 'week', 'month'];

const LANGUAGE_LABELS = {
  en: 'English',
  ru: 'Русский',
};

new Vue({
  el: '#app',
  components: {
    apexchart: VueApexCharts,
  },
  i18n,
  data: {
    authenticated: null,
    setupState: {
      needsSetup: false,
      configured: false,
      hasPassword: false,
      wgHostConfigured: false,
      defaultDns: '',
    },
    serviceName: 'RenNetline',
    awgVersion: '2',
    settingUp: false,
    setupPassword: '',
    setupPasswordConfirm: '',
    setupWgHost: '',
    setupDefaultDns: '',
    setupRuntime: {
      wgPort: '51820',
      wgConfigPort: '51820',
      wgMtu: '',
      wgDefaultAddress: '10.8.0.x',
      wgAllowedIps: '0.0.0.0/0, ::/0',
      wgPersistentKeepalive: '0',
      uiTrafficStats: true,
      uiChartType: 0,
      enableOneTimeLinks: false,
      enableSortClients: false,
      enableExpireTime: false,
      avatarDicebearType: '',
      avatarUseGravatar: false,
      trafficHistoryEnabled: false,
      trafficSampleIntervalSeconds: 1,
      trafficRawRetentionHours: 24,
      trafficMinuteRetentionDays: 90,
      trafficHourRetentionDays: 365,
    },
    authenticating: false,
    password: null,
    requiresPassword: null,
    remember: false,
    rememberMeEnabled: false,
    currentPage: 'clients',

    clients: null,
    clientIsolation: {
      enabled: false,
      availableGroups: [],
      rules: [],
    },
    clientIsolationSaving: false,
    aclDraggingRuleId: null,
    aclDragOverRuleId: null,
    uplinks: [],
    uplinkConfigOptions: [],
    uplinkProtectedCidrsText: '',
    uplinkProtectedCidrsSaving: false,
    dnsRouting: {
      enabled: false,
      resolveEnabled: false,
      upstreamsText: '',
      listenAddress: '',
    },
    dnsResolveStatus: {
      running: false,
      total: 0,
      processed: 0,
      errors: 0,
      eta: null,
      lastResolved: null,
    },
    dnsResolvePollTimer: null,
    geoSiteLoading: false,
    geoSiteResult: null,
    geoIpLoading: false,
    geoIpResult: null,
    geoIpProtectedLoading: false,
    routingCategories: [],
    dnsLogs: {
      enabled: false,
      logPath: '',
      lines: [],
      updatedAt: null,
    },
    dnsLogsLoading: false,
    settings: {
      wgHost: '',
      defaultDns: '',
      runtime: {
        wgPort: '51820',
        wgConfigPort: '51820',
        wgMtu: '',
        wgDefaultAddress: '10.8.0.x',
        wgAllowedIps: '0.0.0.0/0, ::/0',
        wgPersistentKeepalive: '0',
        uiTrafficStats: true,
        uiChartType: 0,
        enableOneTimeLinks: false,
        enableSortClients: false,
        enableExpireTime: false,
        timezone: '',
        avatarDicebearType: '',
        avatarUseGravatar: false,
        trafficHistoryEnabled: false,
        trafficSampleIntervalSeconds: 1,
        trafficRawRetentionHours: 24,
        trafficMinuteRetentionDays: 90,
        trafficHourRetentionDays: 365,
      },
      hasPassword: false,
      newPassword: '',
      newPasswordConfirm: '',
        telegram: {
          enabled: false,
          token: '',
          adminIds: '',
          pollTimeoutSeconds: 25,
          subscriptionPhoneNumber: '',
          subscriptionRecipientName: '',
          subscriptionBankName: '',
          subscriptionPaymentNote: '',
        },
    },
    settingsSaving: false,
    uplinkSaving: false,
    uplinkSaveState: 'idle',
    uplinkConfigUploading: false,
    uplinkConfigImportFilename: '',
    uplinkConfigImportContent: '',
    uplinkConfigImportSaving: false,
    uplinkAutosaveTimer: null,
    uplinkAutosaveQueued: false,
    uplinkWatchSuspended: false,
    routingCategoriesSaving: false,
    dnsRoutingSaving: false,
    uplinkTestingId: null,
    clientsPersist: {},
    clientDelete: null,
    clientCreate: null,
    clientCreating: false,
    clientCreateName: '',
    clientExpiredDate: '',
    clientEditName: null,
    clientEditNameId: null,
    clientEditAddress: null,
    clientEditAddressId: null,
    clientEditAclGroups: null,
    clientEditAclGroupsId: null,
    clientEditExpireDate: null,
    clientEditExpireDateId: null,
    clientEditEmail: null,
    clientEditEmailId: null,
    clientEditTelegramId: null,
    clientEditTelegramIdId: null,
    clientEditGroups: null,
    clientEditGroupsId: null,
    qrcode: null,
    configText: null,
    configClientName: null,
    notification: {
      visible: false,
      message: '',
      tone: 'info',
    },
    notificationTimer: null,
    eventSource: null,
    liveRefreshTimer: null,
    trafficClient: null,
    trafficHistory: null,
    trafficHistoryPeriod: 'day',
    trafficHistoryLoading: false,
    trafficHistoryError: null,

    currentRelease: null,
    latestRelease: null,

    uiTrafficStats: false,
    trafficHistoryEnabled: false,

    uiChartType: 0,
    avatarSettings: {
      dicebear: null,
      gravatar: false,
    },
    enableOneTimeLinks: false,
    sortField: 'name',
    sortDirection: 'asc',
    searchQuery: '',
    pageSize: 10,
    currentPageNum: 1,
    enableExpireTime: false,

    uiShowCharts: localStorage.getItem('uiShowCharts') === '1',
    uiTheme: localStorage.theme || 'auto',
    uiLanguage: localStorage.getItem('lang') || 'ru',
    languageMenuOpen: false,
    languageMenuPosition: {
      top: 0,
      left: 0,
      width: 176,
    },
    prefersDarkScheme: window.matchMedia('(prefers-color-scheme: dark)'),

    chartOptions: {
      chart: {
        background: 'transparent',
        stacked: false,
        toolbar: {
          show: false,
        },
        animations: {
          enabled: false,
        },
        parentHeightOffset: 0,
        sparkline: {
          enabled: true,
        },
      },
      colors: [],
      stroke: {
        curve: 'smooth',
      },
      fill: {
        type: 'gradient',
        gradient: {
          shade: 'dark',
          type: 'vertical',
          shadeIntensity: 0,
          gradientToColors: CHART_COLORS.gradient[this.theme],
          inverseColors: false,
          opacityTo: 0,
          stops: [0, 100],
        },
      },
      dataLabels: {
        enabled: false,
      },
      plotOptions: {
        bar: {
          horizontal: false,
        },
      },
      xaxis: {
        labels: {
          show: false,
        },
        axisTicks: {
          show: false,
        },
        axisBorder: {
          show: false,
        },
      },
      yaxis: {
        labels: {
          show: false,
        },
        min: 0,
      },
      tooltip: {
        enabled: false,
      },
      legend: {
        show: false,
      },
      grid: {
        show: false,
        padding: {
          left: -10,
          right: 0,
          bottom: -15,
          top: -15,
        },
        column: {
          opacity: 0,
        },
        xaxis: {
          lines: {
            show: false,
          },
        },
      },
    },

  },
  methods: {
    dateTime: (value) => {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }).format(value);
    },
    // Convert datetime-local input value (e.g. "2026-06-23T21:06") to ISO 8601.
    // Uses component-based Date constructor to guarantee local-time interpretation
    // across all browsers (avoids ambiguous Date.parse of timezone-less strings).
    toISOFromDatetimeLocal(value) {
      if (!value) return '';
      const [datePart, timePart] = value.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hours, minutes] = (timePart || '00:00').split(':').map(Number);
      const d = new Date(year, month - 1, day, hours || 0, minutes || 0);
      return d.toISOString();
    },
    // Convert ISO 8601 string (or Date object) back to datetime-local format
    // in the configured timezone (or browser default if not set).
    toDatetimeLocalFromISO(value) {
      if (!value) return '';
      const d = new Date(value);
      const tz = this.settings.runtime.timezone || undefined;
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts = fmt.formatToParts(d);
      const get = (type) => parts.find(p => p.type === type)?.value || '00';
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    },
    async refresh({
      updateCharts = false,
    } = {}) {
      if (!this.authenticated) return;

      const clients = await this.api.getClients();
      this.clients = clients.map((client) => {
        if (client.name.includes('@') && client.name.includes('.') && this.avatarSettings.gravatar) {
          client.avatar = `https://gravatar.com/avatar/${sha256(client.name.toLowerCase().trim())}.jpg`;
        } else if (this.avatarSettings.dicebear) {
          client.avatar = `https://api.dicebear.com/9.x/${this.avatarSettings.dicebear}/svg?seed=${sha256(client.name.toLowerCase().trim())}`;
        }

        if (!this.clientsPersist[client.id]) {
          this.clientsPersist[client.id] = {};
          this.clientsPersist[client.id].transferRxHistory = Array(50).fill(0);
          this.clientsPersist[client.id].transferRxPrevious = client.transferRx;
          this.clientsPersist[client.id].transferTxHistory = Array(50).fill(0);
          this.clientsPersist[client.id].transferTxPrevious = client.transferTx;
        }

        // Debug
        // client.transferRx = this.clientsPersist[client.id].transferRxPrevious + Math.random() * 1000;
        // client.transferTx = this.clientsPersist[client.id].transferTxPrevious + Math.random() * 1000;
        // client.latestHandshakeAt = new Date();
        // this.requiresPassword = true;

        this.clientsPersist[client.id].transferRxCurrent = client.transferRx - this.clientsPersist[client.id].transferRxPrevious;
        this.clientsPersist[client.id].transferRxPrevious = client.transferRx;
        this.clientsPersist[client.id].transferTxCurrent = client.transferTx - this.clientsPersist[client.id].transferTxPrevious;
        this.clientsPersist[client.id].transferTxPrevious = client.transferTx;

        if (updateCharts) {
          this.clientsPersist[client.id].transferRxHistory.push(this.clientsPersist[client.id].transferRxCurrent);
          this.clientsPersist[client.id].transferRxHistory.shift();

          this.clientsPersist[client.id].transferTxHistory.push(this.clientsPersist[client.id].transferTxCurrent);
          this.clientsPersist[client.id].transferTxHistory.shift();

          this.clientsPersist[client.id].transferTxSeries = [{
            name: 'Tx',
            data: this.clientsPersist[client.id].transferTxHistory,
          }];

          this.clientsPersist[client.id].transferRxSeries = [{
            name: 'Rx',
            data: this.clientsPersist[client.id].transferRxHistory,
          }];

          client.transferTxHistory = this.clientsPersist[client.id].transferTxHistory;
          client.transferRxHistory = this.clientsPersist[client.id].transferRxHistory;
          client.transferMax = Math.max(...client.transferTxHistory, ...client.transferRxHistory);

          client.transferTxSeries = this.clientsPersist[client.id].transferTxSeries;
          client.transferRxSeries = this.clientsPersist[client.id].transferRxSeries;
        }

        client.transferTxCurrent = this.clientsPersist[client.id].transferTxCurrent;
        client.transferRxCurrent = this.clientsPersist[client.id].transferRxCurrent;

        client.hoverTx = this.clientsPersist[client.id].hoverTx;
        client.hoverRx = this.clientsPersist[client.id].hoverRx;

        // Normalize uplinkId: null/'main' → '' for select binding
        if (!client.uplinkId || client.uplinkId === 'main') {
          client.uplinkId = '';
        }

        return client;
      });

    },
    async refreshClientIsolation() {
      if (!this.authenticated) return;
      const settings = await this.api.getClientIsolation();
      this.clientIsolation = {
        enabled: settings.enabled === true,
        availableGroups: Array.isArray(settings.availableGroups) ? settings.availableGroups : [],
        rules: Array.isArray(settings.rules) ? settings.rules : [],
      };
    },
    async refreshUplinkSettings() {
      if (!this.authenticated) return;
      const uplinks = await this.api.getUplinks();
      this.uplinkWatchSuspended = true;
      this.uplinks = Array.isArray(uplinks)
        ? uplinks.map((uplink, index) => this.normalizeUplinkSettings(uplink, index))
        : [];
      this.$nextTick(() => {
        this.uplinkWatchSuspended = false;
      });
    },
    async refreshUplinkProtectedCidrs() {
      if (!this.authenticated) return;
      const settings = await this.api.getUplinkProtectedCidrs();
      this.uplinkProtectedCidrsText = Array.isArray(settings.cidrs)
        ? settings.cidrs.join('\n')
        : '';
    },
    async refreshUplinkConfigOptions() {
      if (!this.authenticated) return;
      const configs = await this.api.getUplinkConfigs();
      this.uplinkConfigOptions = Array.isArray(configs) ? configs : [];
    },
    async refreshDnsRouting({ fromSse = false } = {}) {
      if (!this.authenticated) return;
      // Skip SSE refreshes on uplink page — user may be editing DNS settings
      if (fromSse && this.currentPage === 'uplink') return;
      const settings = await this.api.getDnsRouting();
      this.dnsRouting = {
        enabled: settings.enabled === true,
        resolveEnabled: settings.resolveEnabled === true,
        upstreamsText: Array.isArray(settings.upstreams) ? settings.upstreams.join('\n') : '',
        listenAddress: typeof settings.listenAddress === 'string' ? settings.listenAddress : '',
      };
      // Fetch resolve status too
      this.refreshDnsResolveStatus();
    },
    async refreshDnsLogs(limit = 200) {
      if (!this.authenticated) return;
      this.dnsLogsLoading = true;
      try {
        const logs = await this.api.getDnsLogs(limit);
        this.dnsLogs = {
          enabled: logs.enabled === true,
          logPath: typeof logs.logPath === 'string' ? logs.logPath : '',
          lines: Array.isArray(logs.lines) ? logs.lines : [],
          updatedAt: logs.updatedAt || null,
        };
      } finally {
        this.dnsLogsLoading = false;
      }
    },
    async refreshSettings() {
      if (!this.authenticated) return;
      const settings = await this.api.getSettings();
      this.settings = {
        wgHost: typeof settings.wgHost === 'string' ? settings.wgHost : '',
        defaultDns: typeof settings.defaultDns === 'string' ? settings.defaultDns : '',
        runtime: {
          wgPort: typeof settings.runtime?.wgPort === 'string' ? settings.runtime.wgPort : '51820',
          wgConfigPort: typeof settings.runtime?.wgConfigPort === 'string' ? settings.runtime.wgConfigPort : '51820',
          wgMtu: typeof settings.runtime?.wgMtu === 'string' ? settings.runtime.wgMtu : '',
          wgDefaultAddress: typeof settings.runtime?.wgDefaultAddress === 'string' ? settings.runtime.wgDefaultAddress : '10.8.0.x',
          wgAllowedIps: typeof settings.runtime?.wgAllowedIps === 'string' ? settings.runtime.wgAllowedIps : '0.0.0.0/0, ::/0',
          wgPersistentKeepalive: typeof settings.runtime?.wgPersistentKeepalive === 'string' ? settings.runtime.wgPersistentKeepalive : '0',
          uiTrafficStats: settings.runtime?.uiTrafficStats === true,
          uiChartType: Number.parseInt(settings.runtime?.uiChartType, 10) || 0,
          enableOneTimeLinks: settings.runtime?.enableOneTimeLinks === true,
          enableSortClients: settings.runtime?.enableSortClients === true,
          enableExpireTime: settings.runtime?.enableExpireTime === true,
          timezone: typeof settings.runtime?.timezone === 'string' ? settings.runtime.timezone : '',
          avatarDicebearType: typeof settings.runtime?.avatarDicebearType === 'string' ? settings.runtime.avatarDicebearType : '',
          avatarUseGravatar: settings.runtime?.avatarUseGravatar === true,
          trafficHistoryEnabled: settings.runtime?.trafficHistoryEnabled === true,
          trafficSampleIntervalSeconds: Number.parseInt(settings.runtime?.trafficSampleIntervalSeconds, 10) || 1,
          trafficRawRetentionHours: Number.parseInt(settings.runtime?.trafficRawRetentionHours, 10) || 24,
          trafficMinuteRetentionDays: Number.parseInt(settings.runtime?.trafficMinuteRetentionDays, 10) || 90,
          trafficHourRetentionDays: Number.parseInt(settings.runtime?.trafficHourRetentionDays, 10) || 365,
        },
        hasPassword: settings.hasPassword === true,
        newPassword: '',
        newPasswordConfirm: '',
        telegram: {
          enabled: settings.telegram && settings.telegram.enabled === true,
          token: typeof settings.telegram?.token === 'string' ? settings.telegram.token : '',
          adminIds: typeof settings.telegram?.adminIds === 'string' ? settings.telegram.adminIds : '',
          pollTimeoutSeconds: Number.parseInt(settings.telegram?.pollTimeoutSeconds, 10) || 25,
          subscriptionPhoneNumber: typeof settings.telegram?.subscriptionPhoneNumber === 'string'
            ? settings.telegram.subscriptionPhoneNumber
            : '',
          subscriptionRecipientName: typeof settings.telegram?.subscriptionRecipientName === 'string'
            ? settings.telegram.subscriptionRecipientName
            : '',
          subscriptionBankName: typeof settings.telegram?.subscriptionBankName === 'string'
            ? settings.telegram.subscriptionBankName
            : '',
          subscriptionPaymentNote: typeof settings.telegram?.subscriptionPaymentNote === 'string'
            ? settings.telegram.subscriptionPaymentNote
            : '',
        },
      };
    },
    async loadAuthenticatedUiFlags() {
      try {
        this.uiTrafficStats = await this.api.getuiTrafficStats();
      } catch {
        this.uiTrafficStats = false;
      }

      try {
        const res = await this.api.getChartType();
        this.uiChartType = parseInt(res, 10);
      } catch {
        this.uiChartType = 0;
      }

      try {
        const trafficOverview = await this.api.getTrafficOverview();
        this.trafficHistoryEnabled = trafficOverview && trafficOverview.enabled === true;
      } catch {
        this.trafficHistoryEnabled = false;
      }

      try {
        this.enableOneTimeLinks = await this.api.getWGEnableOneTimeLinks();
      } catch {
        this.enableOneTimeLinks = false;
      }

      try {
        this.enableSortClient = await this.api.getUiSortClients();
      } catch {
        this.enableSortClient = false;
      }

      try {
        this.enableExpireTime = await this.api.getWGEnableExpireTime();
      } catch {
        this.enableExpireTime = false;
      }

      try {
        this.avatarSettings = await this.api.getAvatarSettings();
      } catch {
        this.avatarSettings = {
          dicebear: null,
          gravatar: false,
        };
      }
    },
    async loadAuthenticatedRuntimeInfo() {
      try {
        this.rememberMeEnabled = await this.api.getRememberMeEnabled();
      } catch {
        this.rememberMeEnabled = false;
      }

      try {
        const lang = await this.api.getLang();
        // Only use server lang as initial default — never override user's choice
        const storedLang = localStorage.getItem('lang');
        if (!storedLang && i18n.availableLocales.includes(lang)) {
          this.setLanguage(lang);
        }
      } catch {
        // Keep local/default language.
      }

      try {
        const currentRelease = await this.api.getRelease();
        const latestRelease = await fetch('https://wg-easy.github.io/wg-easy/changelog.json')
          .then((res) => res.json())
          .then((releases) => {
            const releasesArray = Object.entries(releases).map(([version, changelog]) => ({
              version: parseInt(version, 10),
              changelog,
            }));
            releasesArray.sort((a, b) => {
              return b.version - a.version;
            });

            return releasesArray[0];
          });

        if (currentRelease < latestRelease.version) {
          this.currentRelease = currentRelease;
          this.latestRelease = latestRelease;
        }
      } catch {
        // Optional release info.
      }
    },
    createEmptyUplink(index = 0) {
      return {
        id: `uplink-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 10)}`,
        name: `${this.$t('uplinkItemName')} ${index + 1}`,
        enabled: false,
        configPath: '',
        interfaceName: '',
        table: 200 + index,
        geoSiteSync: false,
        geoIpSync: false,
        sourceRulesText: '',
        destinationDomainsText: '',
        destinationIpsText: '',
      };
    },
    normalizeUplinkSettings(uplink, index = 0) {
      return {
        id: typeof uplink.id === 'string' && uplink.id ? uplink.id : this.createEmptyUplink(index).id,
        name: typeof uplink.name === 'string' && uplink.name
          ? uplink.name
          : `${this.$t('uplinkItemName')} ${index + 1}`,
        enabled: uplink.enabled === true,
        configPath: typeof uplink.configPath === 'string' ? uplink.configPath : '',
        interfaceName: typeof uplink.interfaceName === 'string' ? uplink.interfaceName : '',
        table: Number.parseInt(uplink.table, 10) || 200 + index,
        geoSiteSync: uplink.geoSiteSync === true,
        geoIpSync: uplink.geoIpSync === true,
        sourceRulesText: Array.isArray(uplink.sourceRules) ? uplink.sourceRules.join('\n') : '',
        destinationDomainsText: Array.isArray(uplink.destinationDomains) ? uplink.destinationDomains.join('\n') : '',
        destinationIpsText: Array.isArray(uplink.destinationIps) ? uplink.destinationIps.join('\n') : '',
      };
    },
    syncUplinkInterfaceFromConfig(uplink) {
      if (!uplink || !uplink.configPath) return;
      const selected = this.uplinkConfigOptions.find((option) => option.path === uplink.configPath);
      if (selected) {
        const previousInterface = typeof uplink.interfaceName === 'string' ? uplink.interfaceName.trim() : '';
        const previousName = typeof uplink.name === 'string' ? uplink.name.trim() : '';
        uplink.interfaceName = selected.interfaceName;

        const genericNames = new Set([
          '',
          `${this.$t('uplinkItemName')}`,
          `${this.$t('uplinkItemName')} 1`,
          `${this.$t('uplinkItemName')} 2`,
          `${this.$t('uplinkItemName')} 3`,
          `${this.$t('uplinkItemName')} 4`,
          `${this.$t('uplinkItemName')} 5`,
        ]);
        const shouldReplaceName = !previousName
          || genericNames.has(previousName)
          || previousName === previousInterface;

        if (shouldReplaceName) {
          uplink.name = selected.interfaceName;
        }
      }
    },
    async refreshRoutingCategories() {
      const categories = await this.api.getRoutingCategories();
      this.routingCategories = Array.isArray(categories)
        ? categories.map((category, index) => this.normalizeRoutingCategory(category, index))
        : [];
    },
    login(e) {
      e.preventDefault();

      if (!this.password) return;
      if (this.authenticating) return;

      this.authenticating = true;
      this.api.createSession({
        password: this.password,
        remember: this.remember,
      })
        .then(async () => {
          const session = await this.api.getSession();
          this.authenticated = session.authenticated;
          this.requiresPassword = session.requiresPassword;
          await this.refresh();
          await this.refreshClientIsolation();
          await this.refreshUplinkConfigOptions();
          await this.refreshUplinkSettings();
          await this.refreshUplinkProtectedCidrs();
          await this.refreshRoutingCategories();
          await this.refreshDnsRouting();
          await this.refreshSettings();
          await this.loadAuthenticatedUiFlags();
          await this.loadAuthenticatedRuntimeInfo();
          this.connectRealtime();
        })
        .catch((err) => {
          this.notifyError(err);
        })
        .finally(() => {
          this.authenticating = false;
          this.password = null;
        });
    },
    setup(e) {
      e.preventDefault();

      if (this.settingUp) return;
      if (!this.setupPassword || this.setupPassword.length < 8) {
        this.notifyError(new Error(this.$t('setupPasswordTooShort')));
        return;
      }
      if (this.setupPassword !== this.setupPasswordConfirm) {
        this.notifyError(new Error(this.$t('setupPasswordsDoNotMatch')));
        return;
      }
      if (!this.setupWgHost) {
        this.notifyError(new Error(this.$t('setupHostRequired')));
        return;
      }

      this.settingUp = true;
      this.api.createSetup({
        password: this.setupPassword,
        wgHost: this.setupWgHost,
        defaultDns: this.setupDefaultDns,
        runtime: this.setupRuntime,
      })
        .then(async () => {
          this.notify(this.$t('setupCompleted'), 'success');
          const session = await this.api.getSession();
          this.authenticated = session.authenticated;
          this.requiresPassword = session.requiresPassword;
          this.setupState = {
            needsSetup: session.needsSetup === true,
            configured: session.needsSetup !== true,
            hasPassword: session.requiresPassword === true,
            wgHostConfigured: session.wgHostConfigured === true,
            defaultDns: '',
          };
          this.setupPassword = '';
          this.setupPasswordConfirm = '';
          this.password = '';
          this.setupWgHost = '';
        })
        .catch((err) => {
          this.notifyError(err);
        })
        .finally(() => {
          this.settingUp = false;
        });
    },
    logout(e) {
      e.preventDefault();

      this.api.deleteSession()
        .then(() => {
          this.disconnectRealtime();
          this.authenticated = false;
          this.clients = null;
        })
        .catch((err) => {
          this.notifyError(err);
        });
    },
    saveSettings() {
      if (this.settingsSaving) return;
      if (this.settings.newPassword && this.settings.newPassword.length < 8) {
        this.notifyError(new Error(this.$t('setupPasswordTooShort')));
        return;
      }
      if (this.settings.newPassword !== this.settings.newPasswordConfirm) {
        this.notifyError(new Error(this.$t('setupPasswordsDoNotMatch')));
        return;
      }
      if (!this.settings.wgHost) {
        this.notifyError(new Error(this.$t('setupHostRequired')));
        return;
      }

      this.settingsSaving = true;
      this.api.updateSettings({
        wgHost: this.settings.wgHost,
        defaultDns: this.settings.defaultDns,
        runtime: this.settings.runtime,
        newPassword: this.settings.newPassword,
        telegram: {
          enabled: this.settings.telegram.enabled,
          token: this.settings.telegram.token,
          adminIds: this.settings.telegram.adminIds,
          pollTimeoutSeconds: this.settings.telegram.pollTimeoutSeconds,
          subscriptionPhoneNumber: this.settings.telegram.subscriptionPhoneNumber,
          subscriptionRecipientName: this.settings.telegram.subscriptionRecipientName,
          subscriptionBankName: this.settings.telegram.subscriptionBankName,
          subscriptionPaymentNote: this.settings.telegram.subscriptionPaymentNote,
        },
      })
        .then(() => this.refreshSettings())
        .then(() => this.loadAuthenticatedUiFlags())
        .then(() => {
          this.notify(this.$t('settingsSaved'), 'success');
        })
        .catch((err) => {
          this.notifyError(err);
        })
        .finally(() => {
          this.settingsSaving = false;
        });
    },
    createClient() {
      const name = this.clientCreateName;
      const expiredDate = this.toISOFromDatetimeLocal(this.clientExpiredDate);
      if (!name || this.clientCreating) {
        return;
      }

      this.clientCreating = true;
      this.api.createClient({ name, expiredDate })
        .then(() => Promise.all([
          this.refresh(),
          this.refreshClientIsolation(),
          this.refreshUplinkSettings(),
          this.refreshUplinkProtectedCidrs(),
        ]))
        .then(() => {
          this.clientCreateName = '';
          this.clientExpiredDate = '';
          this.clientCreate = null;
          this.notify(this.$t('settingsSaved'), 'success');
        })
        .catch((err) => {
          this.notifyError(err);
        })
        .finally(() => {
          this.clientCreating = false;
        });
    },
    deleteClient(client) {
      this.api.deleteClient({ clientId: client.id })
        .catch((err) => this.notifyError(err))
        .finally(() => Promise.all([
          this.refresh().catch(console.error),
          this.refreshClientIsolation().catch(console.error),
        ]));
    },
    showOneTimeLink(client) {
      this.api.showOneTimeLink({ clientId: client.id })
        .then(async () => {
          await this.refresh();
          const refreshedClient = this.clients.find((item) => item.id === client.id);
          if (!refreshedClient || !refreshedClient.oneTimeLink) {
            throw new Error('Failed to generate one-time link.');
          }

          const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
          const oneTimeLinkUrl = `${document.location.protocol}//${document.location.host}${basePath}/cnf/${refreshedClient.oneTimeLink}`;
          await this.copyTextToClipboard(oneTimeLinkUrl);
          this.notify(this.$t('oneTimeLinkCopied'), 'success');
        })
        .catch((err) => this.notifyError(err));
    },
    showClientConfiguration(client) {
      this.api.getClientConfiguration({ clientId: client.id })
        .then((configText) => {
          this.configClientName = client.name;
          this.configText = configText;
        })
        .catch((err) => this.notifyError(err));
    },
    closeClientConfiguration() {
      this.configText = null;
      this.configClientName = null;
    },
    async copyVpnKey(client) {
      if (!client.downloadableConfig) return;
      try {
        const key = await this.api.getClientVpnKey({ clientId: client.id });
        await navigator.clipboard.writeText(key);
        this.notify(this.$t('vpnKeyCopied'), 'success');
      } catch (err) {
        this.notifyError(err);
      }
    },
    async downloadVpnConfig(client) {
      if (!client.downloadableConfig) return;
      try {
        const vpnLink = await this.api.getClientVpnConfig({ clientId: client.id });
        // Try to open vpn:// deep link
        const a = document.createElement('a');
        a.href = vpnLink;
        a.click();
      } catch (err) {
        this.notifyError(err);
      }
    },
    escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
    highlightConfigLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return '';

      if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
        return `<span class="text-neutral-500 italic">${this.escapeHtml(line)}</span>`;
      }

      if (/^\[[^\]]+\]$/.test(trimmed)) {
        return `<span class="text-blue-700 dark:text-blue-300 font-semibold">${this.escapeHtml(trimmed)}</span>`;
      }

      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) {
        return this.escapeHtml(line);
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      const normalizedKey = key.toLowerCase();

      const keyClass = 'text-red-700 dark:text-red-300';
      const valueClassesByKey = {
        privatekey: 'text-emerald-700 dark:text-emerald-300',
        publickey: 'text-emerald-700 dark:text-emerald-300',
        presharedkey: 'text-emerald-700 dark:text-emerald-300',
        endpoint: 'text-sky-700 dark:text-sky-300',
        address: 'text-sky-700 dark:text-sky-300',
        allowedips: 'text-sky-700 dark:text-sky-300',
        dns: 'text-sky-700 dark:text-sky-300',
        listenport: 'text-amber-700 dark:text-amber-300',
        persistentkeepalive: 'text-amber-700 dark:text-amber-300',
        mtu: 'text-amber-700 dark:text-amber-300',
        jc: 'text-amber-700 dark:text-amber-300',
        jmin: 'text-amber-700 dark:text-amber-300',
        jmax: 'text-amber-700 dark:text-amber-300',
        s1: 'text-amber-700 dark:text-amber-300',
        s2: 'text-amber-700 dark:text-amber-300',
        h1: 'text-amber-700 dark:text-amber-300',
        h2: 'text-amber-700 dark:text-amber-300',
        h3: 'text-amber-700 dark:text-amber-300',
        h4: 'text-amber-700 dark:text-amber-300',
        postup: 'text-violet-700 dark:text-violet-300',
        preup: 'text-violet-700 dark:text-violet-300',
        postdown: 'text-violet-700 dark:text-violet-300',
        predown: 'text-violet-700 dark:text-violet-300',
      };
      const valueClass = valueClassesByKey[normalizedKey] || 'text-gray-900 dark:text-neutral-100';

      return `<span class="${keyClass}">${this.escapeHtml(key)}</span><span class="text-neutral-500"> = </span><span class="${valueClass}">${this.escapeHtml(value)}</span>`;
    },
    formatBytesValue(value, decimals = 2) {
      return bytes(Number(value || 0), decimals);
    },
    formatRateValue(value) {
      return `${this.formatBytesValue(value)}/s`;
    },
    formatTrafficPeriodLabel(period) {
      return this.$t(`traffic.period.${period}`);
    },
    downsampleTrafficSeries(series, maxPoints = 240) {
      if (!Array.isArray(series) || series.length <= maxPoints) {
        return series;
      }

      const bucketSize = Math.ceil(series.length / maxPoints);
      const reduced = [];

      for (let index = 0; index < series.length; index += bucketSize) {
        const bucket = series.slice(index, index + bucketSize);
        const last = bucket[bucket.length - 1];
        const avg = bucket.reduce((sum, point) => sum + point.y, 0) / bucket.length;
        reduced.push({
          x: last.x,
          y: avg,
        });
      }

      return reduced;
    },
    normalizeTrafficHistory(trafficHistory) {
      return {
        ...trafficHistory,
        live: trafficHistory.live
          ? {
            ...trafficHistory.live,
            sampledAt: new Date(trafficHistory.live.ts),
          }
          : null,
        series: Array.isArray(trafficHistory.series)
          ? trafficHistory.series.map((point) => ({
            ...point,
            sampledAt: new Date(point.ts),
          }))
          : [],
      };
    },
    openClientTraffic(client) {
      if (!this.trafficHistoryEnabled) {
        this.notify(this.$t('traffic.disabled'), 'error');
        return;
      }
      this.trafficClient = client;
      this.trafficHistory = null;
      this.trafficHistoryError = null;
      this.loadClientTraffic('day');
    },
    closeClientTraffic() {
      this.trafficClient = null;
      this.trafficHistory = null;
      this.trafficHistoryError = null;
      this.trafficHistoryLoading = false;
    },
    loadClientTraffic(period) {
      if (!this.trafficClient || this.trafficHistoryLoading || !TRAFFIC_PERIODS.includes(period)) return;

      this.trafficHistoryPeriod = period;
      this.trafficHistoryLoading = true;
      this.trafficHistoryError = null;

      this.api.getClientTraffic({ clientId: this.trafficClient.id, period })
        .then((trafficHistory) => {
          this.trafficHistory = this.normalizeTrafficHistory(trafficHistory);
        })
        .catch((err) => {
          this.trafficHistoryError = err.message || err.toString();
        })
        .finally(() => {
          this.trafficHistoryLoading = false;
        });
    },
    async copyClientConfiguration() {
      if (!this.configText) return;

      try {
        await this.copyTextToClipboard(this.configText);
        this.notify(this.$t('configCopied'), 'success');
      } catch (err) {
        this.notifyError(err);
      }
    },
    async copyTextToClipboard(text) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }

      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textArea);

      if (!copied) {
        throw new Error('Failed to copy text.');
      }
    },
    notify(message, tone = 'info') {
      if (!message) return;

      this.notification.visible = true;
      this.notification.message = message;
      this.notification.tone = tone;

      if (this.notificationTimer) {
        clearTimeout(this.notificationTimer);
      }

      this.notificationTimer = setTimeout(() => {
        this.dismissNotification();
      }, 4200);
    },
    notifyError(err) {
      const message = err && (err.message || err.toString())
        ? (err.message || err.toString())
        : this.$t('genericError');
      this.notify(message, 'error');
    },
    dismissNotification() {
      this.notification.visible = false;
      this.notification.message = '';
      this.notification.tone = 'info';

      if (this.notificationTimer) {
        clearTimeout(this.notificationTimer);
        this.notificationTimer = null;
      }
    },
    enableClient(client) {
      this.api.enableClient({ clientId: client.id })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    disableClient(client) {
      this.api.disableClient({ clientId: client.id })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientName(client, name) {
      this.api.updateClientName({ clientId: client.id, name })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientAddress(client, address) {
      this.api.updateClientAddress({ clientId: client.id, address })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientAclGroups(client, aclGroups) {
      const parsedGroups = typeof aclGroups === 'string'
        ? aclGroups.split(/[,\n;]+/).map((group) => group.trim()).filter(Boolean)
        : aclGroups;

      this.api.updateClientAclGroups({ clientId: client.id, aclGroups: parsedGroups })
        .catch((err) => this.notifyError(err))
        .finally(() => Promise.all([
          this.refresh().catch(console.error),
          this.refreshClientIsolation().catch(console.error),
        ]));
    },
    startEditExpireDate(client) {
      this.clientEditExpireDate = this.toDatetimeLocalFromISO(client.expiredAt);
      this.clientEditExpireDateId = client.id;
      this.$nextTick(() => {
        const ref = this.$refs['client-' + client.id + '-expire'];
        if (ref && ref[0]) ref[0].select();
      });
    },
    updateClientExpireDate(client, expireDate) {
      const isoDate = this.toISOFromDatetimeLocal(expireDate);
      this.api.updateClientExpireDate({ clientId: client.id, expireDate: isoDate })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientTelegramId(client, value) {
      const telegramId = (value || '').trim();
      if (telegramId && !/^\d+$/.test(telegramId)) {
        this.notify(this.$t('validationDigitsOnly'), 'error');
        return;
      }
      if (telegramId === (client.telegramId || '')) return;
      this.api.updateClientTelegramId({ clientId: client.id, telegramId })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientEmail(client, value) {
      const email = (value || '').trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        this.notify(this.$t('validationEmailFormat'), 'error');
        return;
      }
      if (email === (client.email || '')) return;
      this.api.updateClientEmail({ clientId: client.id, email })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientGroups(client, value) {
      const raw = (value || '').trim();
      if (!raw) {
        if (JSON.stringify([]) === JSON.stringify(client.groups || [])) return;
        this.api.updateClientGroups({ clientId: client.id, groups: [] })
          .catch((err) => this.notifyError(err))
          .finally(() => this.refresh().catch(console.error));
        return;
      }
      const groups = [...new Set(raw.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean))];
      if (JSON.stringify(groups) === JSON.stringify(client.groups || [])) return;
      this.api.updateClientGroups({ clientId: client.id, groups })
        .catch((err) => this.notifyError(err))
        .finally(() => this.refresh().catch(console.error));
    },
    goToPage(page) {
      this.currentPageNum = Math.max(1, Math.min(page, this.totalPages));
    },
    __saveViewState() {
      try {
        localStorage.setItem('clientsViewState', JSON.stringify({
          sortField: this.sortField,
          sortDirection: this.sortDirection,
          pageSize: this.pageSize,
        }));
      } catch {}
    },
    __loadViewState() {
      try {
        const saved = localStorage.getItem('clientsViewState');
        if (saved) {
          const state = JSON.parse(saved);
          if (state.sortField) this.sortField = state.sortField;
          if (state.sortDirection) this.sortDirection = state.sortDirection;
          if (state.pageSize) this.pageSize = state.pageSize;
        }
      } catch {}
    },
    clientIsOnline(client) {
      return Boolean(client && client.latestHandshakeAt
        && (new Date() - new Date(client.latestHandshakeAt) < 1000 * 60 * 10));
    },
    createIsolationRule() {
      const clients = Array.isArray(this.clients) ? this.clients : [];
      if (clients.length < 2) return;

      const [sourceClient, targetClient] = clients;
      const rule = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        action: 'allow',
        sourceType: 'client',
        sourceValue: sourceClient.id,
        targetType: 'client',
        targetValue: targetClient.id,
        bidirectional: true,
        enabled: true,
      };

      this.normalizeIsolationRule(rule);
      this.clientIsolation.rules.push(rule);
    },
    removeIsolationRule(ruleId) {
      this.clientIsolation.rules = this.clientIsolation.rules.filter((rule) => rule.id !== ruleId);
    },
    startAclRuleDrag(ruleId) {
      this.aclDraggingRuleId = ruleId;
      this.aclDragOverRuleId = ruleId;
    },
    setAclDragOver(ruleId) {
      if (!this.aclDraggingRuleId || this.aclDraggingRuleId === ruleId) {
        return;
      }

      this.aclDragOverRuleId = ruleId;
    },
    dropAclRule(targetRuleId) {
      const draggedRuleId = this.aclDraggingRuleId;
      this.aclDraggingRuleId = null;
      this.aclDragOverRuleId = null;

      if (!draggedRuleId || draggedRuleId === targetRuleId) {
        return;
      }

      const rules = [...this.clientIsolation.rules];
      const draggedIndex = rules.findIndex((rule) => rule.id === draggedRuleId);
      const targetIndex = rules.findIndex((rule) => rule.id === targetRuleId);

      if (draggedIndex === -1 || targetIndex === -1) {
        return;
      }

      const [draggedRule] = rules.splice(draggedIndex, 1);
      const nextTargetIndex = rules.findIndex((rule) => rule.id === targetRuleId);
      rules.splice(nextTargetIndex, 0, draggedRule);
      this.clientIsolation.rules = rules;
    },
    endAclRuleDrag() {
      this.aclDraggingRuleId = null;
      this.aclDragOverRuleId = null;
    },
    getAclSelectorValueOptions(selectorType) {
      if (selectorType === 'client') {
        return Array.isArray(this.clients)
          ? this.clients.map((client) => ({
            value: client.id,
            label: `${client.name} (${client.address})`,
          }))
          : [];
      }

      if (selectorType === 'group') {
        return Array.isArray(this.clientIsolation.availableGroups)
          ? this.clientIsolation.availableGroups.map((groupName) => ({
            value: groupName,
            label: groupName,
          }))
          : [];
      }

      return [];
    },
    aclSelectorUsesPreset(selectorType) {
      return selectorType === 'client' || selectorType === 'group';
    },
    aclSelectorRequiresFreeform(selectorType) {
      return selectorType === 'cidr';
    },
    normalizeIsolationRule(rule) {
      if (rule.sourceType === 'all') {
        rule.sourceValue = '';
      }

      if (rule.sourceType === 'client' && !rule.sourceValue && Array.isArray(this.clients) && this.clients[0]) {
        rule.sourceValue = this.clients[0].id;
      }

      if (rule.sourceType === 'group' && !this.clientIsolation.availableGroups.length) {
        rule.sourceType = 'client';
        rule.sourceValue = Array.isArray(this.clients) && this.clients[0] ? this.clients[0].id : '';
      }

      if (rule.targetType === 'all') {
        rule.targetValue = '';
      }

      if (rule.targetType === 'client' && !rule.targetValue && Array.isArray(this.clients) && this.clients[0]) {
        rule.targetValue = this.clients[0].id;
      }

      if (rule.targetType === 'group' && !this.clientIsolation.availableGroups.length) {
        rule.targetType = 'client';
        rule.targetValue = Array.isArray(this.clients) && this.clients[0] ? this.clients[0].id : '';
      }

      if (rule.sourceType === 'group' && !rule.sourceValue && this.clientIsolation.availableGroups[0]) {
        rule.sourceValue = this.clientIsolation.availableGroups[0];
      }

      if (rule.targetType === 'group' && !rule.targetValue && this.clientIsolation.availableGroups[0]) {
        rule.targetValue = this.clientIsolation.availableGroups[0];
      }

      if (rule.sourceType === 'cidr' && !rule.sourceValue) {
        rule.sourceValue = '10.8.0.0/24';
      }

      if (rule.targetType === 'cidr' && !rule.targetValue) {
        rule.targetValue = '192.168.1.0/24';
      }
    },
    appendUplinkSourceRule(uplinkId, address) {
      if (!address) return;
      const uplink = this.uplinks.find((candidate) => candidate.id === uplinkId);
      if (!uplink) return;
      const rule = `${address}/32`;
      const rules = uplink.sourceRulesText
        .split(/[\n,;]+/)
        .map((value) => value.trim())
        .filter(Boolean);

      if (!rules.includes(rule)) {
        rules.push(rule);
      }

      uplink.sourceRulesText = rules.join('\n');
    },
    addUplink() {
      this.uplinks.push(this.createEmptyUplink(this.uplinks.length));
    },
    addRoutingCategory() {
      this.routingCategories.push(this.createEmptyRoutingCategory(this.routingCategories.length));
    },
    createEmptyRoutingCategory(index = 0) {
      const firstEnabledUplink = Array.isArray(this.uplinks) ? this.uplinks.find((uplink) => uplink.enabled) : null;
      return {
        id: `routing-category-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 10)}`,
        name: `${this.$t('routingCategoryName')} ${index + 1}`,
        enabled: true,
        uplinkId: firstEnabledUplink ? firstEnabledUplink.id : '',
        domainsText: '',
      };
    },
    normalizeRoutingCategory(category, index = 0) {
      return {
        id: typeof category?.id === 'string' && category.id ? category.id : this.createEmptyRoutingCategory(index).id,
        name: typeof category?.name === 'string' && category.name ? category.name : `${this.$t('routingCategoryName')} ${index + 1}`,
        enabled: category?.enabled !== false,
        uplinkId: typeof category?.uplinkId === 'string' ? category.uplinkId : '',
        domainsText: Array.isArray(category?.domains) ? category.domains.join('\n') : '',
      };
    },
    moveUplink(uplinkId, direction) {
      const index = this.uplinks.findIndex((uplink) => uplink.id === uplinkId);
      if (index === -1) return;

      const targetIndex = direction === 'up'
        ? index - 1
        : index + 1;

      if (targetIndex < 0 || targetIndex >= this.uplinks.length) {
        return;
      }

      const reordered = [...this.uplinks];
      const [uplink] = reordered.splice(index, 1);
      reordered.splice(targetIndex, 0, uplink);
      this.uplinks = reordered;
    },
    removeUplink(uplinkId) {
      this.uplinks = this.uplinks.filter((uplink) => uplink.id !== uplinkId);
    },
    removeRoutingCategory(categoryId) {
      this.routingCategories = this.routingCategories.filter((category) => category.id !== categoryId);
    },
    async assignClientUplink(client) {
      try {
        await this.api.setClientUplink({
          clientId: client.id,
          uplinkId: client.uplinkId || null,
        });
      } catch (err) {
        this.notifyError(err);
        // Revert on error
        this.refresh();
      }
    },
    serializeUplinkSettings() {
      return this.uplinks.map((uplink) => ({
        id: uplink.id,
        name: uplink.name,
        enabled: uplink.enabled,
        configPath: uplink.configPath,
        interfaceName: uplink.interfaceName,
        table: uplink.table,
        geoSiteSync: uplink.geoSiteSync === true,
        geoIpSync: uplink.geoIpSync === true,
        sourceRules: (uplink.sourceRulesText || '')
          .split(/[\n,;]+/)
          .map((value) => value.trim())
          .filter(Boolean),
        destinationDomains: (uplink.destinationDomainsText || '')
          .split(/[\n,;]+/)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
        destinationIps: (uplink.destinationIpsText || '')
          .split(/[\n,;]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      }));
    },
    scheduleUplinkAutosave() {
      if (!this.authenticated || this.uplinkWatchSuspended) return;
      if (this.uplinkAutosaveTimer) {
        clearTimeout(this.uplinkAutosaveTimer);
      }
      this.uplinkSaveState = 'pending';
      this.uplinkAutosaveTimer = setTimeout(() => {
        this.uplinkAutosaveTimer = null;
        this.saveUplinkSettings({ silent: true });
      }, 900);
    },
    saveUplinkSettings({
      silent = false,
    } = {}) {
      if (this.uplinkAutosaveTimer) {
        clearTimeout(this.uplinkAutosaveTimer);
        this.uplinkAutosaveTimer = null;
      }

      // Mutual exclusion: domains OR IPs, not both
      const hasConflict = this.uplinks.some(
        (u) => u.destinationDomainsText && u.destinationIpsText,
      );
      if (hasConflict) {
        this.notifyError(new Error(this.$t('uplinkMutualExclusion')));
        this.uplinkSaveState = 'error';
        this.uplinkSaving = false;
        return;
      }

      if (this.uplinkSaving) return;

      let serialized;
      try {
        serialized = this.serializeUplinkSettings();
      } catch (err) {
        this.uplinkSaveState = 'error';
        this.uplinkSaving = false;
        this.notifyError(err);
        return;
      }

      this.uplinkSaving = true;
      this.uplinkSaveState = 'saving';
      this.api.updateUplinks({
        uplinks: serialized,
      })
        .then((settings) => {
          this.uplinkWatchSuspended = true;
          this.uplinks = Array.isArray(settings)
            ? settings.map((uplink, index) => this.normalizeUplinkSettings(uplink, index))
            : [];
          this.uplinkSaveState = 'saved';
          this.$nextTick(() => {
            this.uplinkWatchSuspended = false;
          });
          if (!silent) {
            this.notify(this.$t('settingsSaved'), 'success');
          }
        })
        .catch((err) => {
          this.uplinkSaveState = 'error';
          this.notifyError(err);
        })
        .finally(() => {
          this.uplinkSaving = false;
        });
    },
    saveUplinkProtectedCidrs() {
      if (this.uplinkProtectedCidrsSaving) return;

      this.uplinkProtectedCidrsSaving = true;
      this.api.updateUplinkProtectedCidrs({
        cidrs: this.uplinkProtectedCidrsText
          .split(/[\n,;]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      })
        .then((settings) => {
          this.uplinkProtectedCidrsText = Array.isArray(settings.cidrs)
            ? settings.cidrs.join('\n')
            : '';
          this.notify(this.$t('settingsSaved'), 'success');
        })
        .catch((err) => {
          this.notifyError(err);
        })
        .finally(() => {
          this.uplinkProtectedCidrsSaving = false;
        });
    },
    saveRoutingCategories() {
      if (this.routingCategoriesSaving) return;

      this.routingCategoriesSaving = true;
      this.api.updateRoutingCategories({
        categories: this.routingCategories.map((category) => ({
          id: category.id,
          name: category.name,
          enabled: category.enabled === true,
          uplinkId: category.uplinkId || null,
          domains: category.domainsText
            .split(/[\n,;]+/)
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
        })),
      })
        .then((categories) => {
          this.routingCategories = Array.isArray(categories)
            ? categories.map((category, index) => this.normalizeRoutingCategory(category, index))
            : [];
          this.notify(this.$t('settingsSaved'), 'success');
        })
        .catch((err) => this.notifyError(err))
        .finally(() => {
          this.routingCategoriesSaving = false;
        });
    },
    saveDnsRoutingSettings() {
      if (this.dnsRoutingSaving) return;

      const wasResolveEnabled = this.dnsRouting.resolveEnabled;
      this.dnsRoutingSaving = true;
      this.api.updateDnsRouting({
        enabled: this.dnsRouting.enabled,
        resolveEnabled: this.dnsRouting.resolveEnabled,
        upstreams: this.dnsRouting.upstreamsText
          .split(/[\s,\n;]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      })
        .then((settings) => {
          this.dnsRouting = {
            enabled: settings.enabled === true,
            resolveEnabled: settings.resolveEnabled === true,
            upstreamsText: Array.isArray(settings.upstreams) ? settings.upstreams.join('\n') : '',
            listenAddress: typeof settings.listenAddress === 'string' ? settings.listenAddress : '',
          };
          this.notify(this.$t('settingsSaved'), 'success');

          // Auto-start resolve if just enabled
          if (!wasResolveEnabled && this.dnsRouting.resolveEnabled) {
            this.startDnsResolve();
          }
        })
        .catch((err) => this.notifyError(err))
        .finally(() => {
          this.dnsRoutingSaving = false;
        });
    },
    async refreshDnsResolveStatus() {
      try {
        const status = await this.api.getDnsResolveStatus();
        this.dnsResolveStatus = {
          running: status.running === true,
          total: status.total || 0,
          processed: status.processed || 0,
          errors: status.errors || 0,
          eta: status.eta || null,
          lastResolved: status.lastResolved || null,
        };
        // Start/stop polling based on running state
        if (this.dnsResolveStatus.running && !this.dnsResolvePollTimer) {
          this.dnsResolvePollTimer = setInterval(() => {
            if (!this.dnsResolveStatus.running) {
              clearInterval(this.dnsResolvePollTimer);
              this.dnsResolvePollTimer = null;
              return;
            }
            this.refreshDnsResolveStatus();
          }, 2000);
        } else if (!this.dnsResolveStatus.running && this.dnsResolvePollTimer) {
          clearInterval(this.dnsResolvePollTimer);
          this.dnsResolvePollTimer = null;
          this.notify(this.$t('dnsResolveDone', {
            N: this.dnsResolveStatus.total,
            e: this.dnsResolveStatus.errors,
          }), 'success');
        }
      } catch {
        // silently ignore — may be called before page is ready
      }
    },
    async startDnsResolve() {
      try {
        const result = await this.api.startDnsResolve();
        if (result.cached) {
          this.notify(this.$t('dnsResolveUpToDate', { N: result.total }), 'success');
          await this.refreshDnsResolveStatus();
          return;
        }
        this.dnsResolveStatus = {
          running: true,
          total: result.total || 0,
          processed: 0,
          errors: 0,
          eta: null,
          lastResolved: this.dnsResolveStatus.lastResolved,
        };
        this.notify(this.$t('dnsResolveProgress', { n: 0, N: result.total }), 'success');
        // Start polling
        if (!this.dnsResolvePollTimer) {
          this.dnsResolvePollTimer = setInterval(() => {
            if (!this.dnsResolveStatus.running) {
              clearInterval(this.dnsResolvePollTimer);
              this.dnsResolvePollTimer = null;
              return;
            }
            this.refreshDnsResolveStatus();
          }, 2000);
        }
      } catch (err) {
        this.notifyError(err);
      }
    },
    async loadGeoSite() {
      if (this.geoSiteLoading) return;
      this.geoSiteLoading = true;
      this.geoSiteResult = null;
      try {
        const result = await this.api.loadGeoSite();
        this.geoSiteResult = result;
        // Merge loaded domains into each uplink's textarea (same pattern as loadGeoIp)
        this.uplinks.forEach((uplink) => {
          let added = 0;
          const current = new Set(
            (uplink.destinationDomainsText || '').split(/[\n,;]+/)
              .map((s) => s.trim().toLowerCase()).filter(Boolean),
          );
          for (const cat of result.categories) {
            for (const d of cat.domains) {
              if (!current.has(d)) { current.add(d); added++; }
            }
          }
          uplink.destinationDomainsText = [...current].sort().join('\n');
          this.geoSiteResult = added;
        });
        this.notify(this.$t('geoSiteLoaded', {
          N: result.totalDomains,
          M: result.totalFiles,
        }), 'success');
      } catch (err) {
        this.notifyError(err);
      } finally {
        this.geoSiteLoading = false;
      }
    },
    async loadGeoIp() {
      if (this.geoIpLoading) return;
      this.geoIpLoading = true;
      this.geoIpResult = null;
      try {
        const result = await this.api.loadGeoIp();
        // Merge with existing — add only new CIDRs
        this.uplinks.forEach((uplink) => {
          const current = new Set((uplink.destinationIpsText || '').split('\n').filter(Boolean));
          let added = 0;
          for (const cat of result.categories) {
            for (const cidr of cat.cidrs) {
              if (!current.has(cidr)) { current.add(cidr); added++; }
            }
          }
          uplink.destinationIpsText = [...current].sort().join('\n');
          this.geoIpResult = added;
        });
        this.notify(this.$t('geoIpLoaded', { N: this.geoIpResult }), 'success');
      } catch (err) {
        this.notifyError(err);
      } finally {
        this.geoIpLoading = false;
      }
    },
    async loadGeoIpToProtected() {
      if (this.geoIpProtectedLoading) return;
      this.geoIpProtectedLoading = true;
      try {
        const result = await this.api.loadGeoIp();
        const current = new Set((this.uplinkProtectedCidrsText || '').split('\n').filter(Boolean));
        let added = 0;
        for (const cat of result.categories) {
          for (const cidr of cat.cidrs) {
            if (!current.has(cidr)) { current.add(cidr); added++; }
          }
        }
        this.uplinkProtectedCidrsText = [...current].sort().join('\n');
        this.notify(this.$t('geoIpLoaded', { N: added }), 'success');
      } catch (err) {
        this.notifyError(err);
      } finally {
        this.geoIpProtectedLoading = false;
      }
    },
    testUplinkConnection(uplinkId = null) {
      if (this.uplinkTestingId) return;

      if (uplinkId) {
        const uplink = this.uplinks.find((candidate) => candidate.id === uplinkId);
        if (!uplink) {
          this.notifyError(new Error('Selected uplink is not available in the current UI state.'));
          return;
        }

        if (!uplink.configPath || !uplink.interfaceName) {
          this.notifyError(new Error('Set config path and interface name before testing the uplink.'));
          return;
        }
      }

      this.uplinkTestingId = uplinkId || '__default__';
      this.api.testUplinkConnection(uplinkId)
        .then((result) => {
          this.notify(result.message || this.$t('uplinkTestSuccess'), 'success');
        })
        .catch((err) => this.notifyError(err))
        .finally(() => {
          this.uplinkTestingId = null;
        });
    },
    async uploadUplinkConfig(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;
      if (this.uplinkConfigUploading) return;

      this.uplinkConfigUploading = true;
      try {
        const content = await file.text();
        await this.api.uploadUplinkConfig({
          filename: file.name,
          content,
        });
        await this.refreshUplinkConfigOptions();
        this.notify(this.$t('uplinkConfigUploaded'), 'success');
      } catch (err) {
        this.notifyError(err);
      } finally {
        this.uplinkConfigUploading = false;
        if (event?.target) {
          event.target.value = '';
        }
      }
    },
    async savePastedUplinkConfig() {
      if (this.uplinkConfigImportSaving) return;

      const filenameInput = this.uplinkConfigImportFilename.trim();
      const content = this.uplinkConfigImportContent;
      if (!filenameInput || !content.trim()) {
        this.notifyError(new Error(this.$t('uplinkConfigImportRequired')));
        return;
      }

      const filename = /\.(conf|txt)$/i.test(filenameInput)
        ? filenameInput
        : `${filenameInput}.conf`;

      this.uplinkConfigImportSaving = true;
      try {
        await this.api.uploadUplinkConfig({
          filename,
          content,
        });
        await this.refreshUplinkConfigOptions();
        this.uplinkConfigImportFilename = '';
        this.uplinkConfigImportContent = '';
        this.notify(this.$t('uplinkConfigUploaded'), 'success');
      } catch (err) {
        this.notifyError(err);
      } finally {
        this.uplinkConfigImportSaving = false;
      }
    },
    saveClientIsolation() {
      if (this.clientIsolationSaving) return;

      this.clientIsolationSaving = true;
      this.api.updateClientIsolation({
        enabled: this.clientIsolation.enabled,
        rules: this.clientIsolation.rules,
      })
        .then((settings) => {
          this.clientIsolation = {
            enabled: settings.enabled === true,
            availableGroups: Array.isArray(settings.availableGroups) ? settings.availableGroups : [],
            rules: Array.isArray(settings.rules) ? settings.rules : [],
          };
          this.notify(this.$t('settingsSaved'), 'success');
        })
        .catch((err) => this.notifyError(err))
        .finally(() => {
          this.clientIsolationSaving = false;
          this.refreshClientIsolation().catch(console.error);
        });
    },
    restoreConfig(e) {
      e.preventDefault();
      const file = e.currentTarget.files.item(0);
      if (file) {
        file.text()
          .then((content) => {
            this.api.restoreConfiguration(content)
              .then((_result) => this.notify(this.$t('configUpdated'), 'success'))
              .catch((err) => this.notifyError(err))
              .finally(() => Promise.all([
                this.refresh().catch(console.error),
                this.refreshClientIsolation().catch(console.error),
                this.refreshUplinkConfigOptions().catch(console.error),
                this.refreshUplinkSettings().catch(console.error),
                this.refreshUplinkProtectedCidrs().catch(console.error),
                this.refreshRoutingCategories().catch(console.error),
              ]));
          })
          .catch((err) => this.notifyError(err));
      } else {
        this.notify(this.$t('fileLoadFailed'), 'error');
      }
    },
    toggleTheme() {
      const themes = ['light', 'dark', 'auto'];
      const currentIndex = themes.indexOf(this.uiTheme);
      const newIndex = (currentIndex + 1) % themes.length;
      this.uiTheme = themes[newIndex];
      localStorage.theme = this.uiTheme;
      this.setTheme(this.uiTheme);
    },
    setTheme(theme) {
      const { classList } = document.documentElement;
      const shouldAddDarkClass = theme === 'dark' || (theme === 'auto' && this.prefersDarkScheme.matches);
      classList.toggle('dark', shouldAddDarkClass);
    },
    handlePrefersChange(e) {
      if (localStorage.theme === 'auto') {
        this.setTheme(e.matches ? 'dark' : 'light');
      }
    },
    toggleCharts() {
      localStorage.setItem('uiShowCharts', this.uiShowCharts ? 1 : 0);
    },
    toggleLanguageMenu() {
      if (!this.languageMenuOpen) {
        this.updateLanguageMenuPosition();
      }
      this.languageMenuOpen = !this.languageMenuOpen;
    },
    selectLanguage(lang) {
      this.setLanguage(lang);
      this.languageMenuOpen = false;
    },
    updateLanguageMenuPosition() {
      const buttonEl = this.$refs.languageMenuButton;
      if (!buttonEl) return;

      const rect = buttonEl.getBoundingClientRect();
      const menuWidth = 176;
      const viewportPadding = 8;
      let left = rect.right - menuWidth;

      if (left < viewportPadding) {
        left = viewportPadding;
      }

      const maxLeft = window.innerWidth - menuWidth - viewportPadding;
      if (left > maxLeft) {
        left = Math.max(viewportPadding, maxLeft);
      }

      this.languageMenuPosition = {
        top: rect.bottom + 4,
        left,
        width: menuWidth,
      };
    },
    setLanguage(lang) {
      if (!i18n.availableLocales.includes(lang)) return;
      this.uiLanguage = lang;
      i18n.locale = lang;
      localStorage.setItem('lang', lang);
    },
    setPage(page) {
      if (!['clients', 'acl', 'uplink', 'dns-logs', 'settings'].includes(page)) return;
      this.currentPage = page;
      if (window.location.hash !== `#${page}`) {
        window.location.hash = page;
      }
    },
    syncPageFromHash() {
      const page = window.location.hash.replace('#', '');
      this.currentPage = ['clients', 'acl', 'uplink', 'dns-logs', 'settings'].includes(page) ? page : 'clients';
    },
    connectRealtime() {
      this.disconnectRealtime();
      if (!this.authenticated) return;

      const source = new EventSource('./api/events');

      source.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!payload || payload.type !== 'state-updated') {
          return;
        }

        Promise.all([
          this.refresh(),
          this.refreshClientIsolation(),
          this.refreshUplinkConfigOptions(),
          this.refreshUplinkSettings(),
          this.refreshUplinkProtectedCidrs(),
          this.refreshRoutingCategories(),
          this.refreshDnsRouting({ fromSse: true }),
          this.currentPage === 'dns-logs' ? this.refreshDnsLogs() : Promise.resolve(),
          this.currentPage === 'settings' ? this.refreshSettings() : Promise.resolve(),
        ]).catch(console.error);
      };

      source.onerror = () => {
        source.close();
        this.eventSource = null;
        if (this.authenticated) {
          setTimeout(() => this.connectRealtime(), 3000);
        }
      };

      this.eventSource = source;
    },
    disconnectRealtime() {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    },
  },
  filters: {
    bytes,
    timeago: (value) => {
      return timeago.format(value, i18n.locale);
    },
    expiredDateFormat: (value) => {
      if (value === null) return i18n.t('Permanent');
      const dateTime = new Date(value);
      const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
      return dateTime.toLocaleString(i18n.locale, options);
    },
    expiredDateEditFormat: (value, timezone) => {
      if (value === null) return '';
      const d = new Date(value);
      const tz = timezone || undefined;
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts = fmt.formatToParts(d);
      const get = (type) => parts.find(p => p.type === type)?.value || '00';
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    },
  },
  watch: {
    uplinks: {
      deep: true,
      handler() {
        this.scheduleUplinkAutosave();
      },
    },
    'dnsRouting.resolveEnabled': {
      handler() {
        if (this.dnsRoutingSaving) return;
        this.saveDnsRoutingSettings();
      },
    },
    sortField() { this.currentPageNum = 1; this.__saveViewState(); },
    sortDirection() { this.__saveViewState(); },
    pageSize() { this.currentPageNum = 1; this.__saveViewState(); },
    searchQuery() { this.currentPageNum = 1; },
  },
  mounted() {
    this.__loadViewState();
    this.handleGlobalClick = (event) => {
      if (!this.languageMenuOpen) return;
      const menuEl = this.$refs.languageMenu;
      if (menuEl && !menuEl.contains(event.target)) {
        this.languageMenuOpen = false;
      }
    };
    this.handleViewportChange = () => {
      if (this.languageMenuOpen) {
        this.updateLanguageMenuPosition();
      }
    };
    document.addEventListener('click', this.handleGlobalClick);
    document.addEventListener('touchstart', this.handleGlobalClick);
    window.addEventListener('resize', this.handleViewportChange);
    window.addEventListener('scroll', this.handleViewportChange, true);
    this.handleHashChange = () => {
      this.syncPageFromHash();
    };
    window.addEventListener('hashchange', this.handleHashChange);
    this.syncPageFromHash();

    this.prefersDarkScheme.addListener(this.handlePrefersChange);
    this.setTheme(this.uiTheme);

    this.api = new API();
    this.api.getSetupState()
      .then(async (setupState) => {
        this.serviceName = setupState.serviceName || 'RenNetline';
        this.awgVersion = setupState.awgVersion || '2';
        this.setupState = {
          needsSetup: setupState.needsSetup === true,
          configured: setupState.configured === true,
          hasPassword: setupState.hasPassword === true,
          wgHostConfigured: setupState.wgHostConfigured === true,
          defaultDns: '',
        };
        this.setupDefaultDns = setupState.defaults?.defaultDns || '1.1.1.1';
        this.setupRuntime = {
          wgPort: typeof setupState.defaults?.wgPort === 'string' ? setupState.defaults.wgPort : '51820',
          wgConfigPort: typeof setupState.defaults?.wgConfigPort === 'string' ? setupState.defaults.wgConfigPort : '51820',
          wgMtu: typeof setupState.defaults?.wgMtu === 'string' ? setupState.defaults.wgMtu : '',
          wgDefaultAddress: typeof setupState.defaults?.wgDefaultAddress === 'string' ? setupState.defaults.wgDefaultAddress : '10.8.0.x',
          wgAllowedIps: typeof setupState.defaults?.wgAllowedIps === 'string' ? setupState.defaults.wgAllowedIps : '0.0.0.0/0, ::/0',
          wgPersistentKeepalive: typeof setupState.defaults?.wgPersistentKeepalive === 'string' ? setupState.defaults.wgPersistentKeepalive : '0',
          uiTrafficStats: setupState.defaults?.uiTrafficStats === true,
          uiChartType: Number.parseInt(setupState.defaults?.uiChartType, 10) || 0,
          enableOneTimeLinks: setupState.defaults?.enableOneTimeLinks === true,
          enableSortClients: setupState.defaults?.enableSortClients === true,
          enableExpireTime: setupState.defaults?.enableExpireTime === true,
          timezone: typeof setupState.defaults?.timezone === 'string' ? setupState.defaults.timezone : '',
          avatarDicebearType: typeof setupState.defaults?.avatarDicebearType === 'string' ? setupState.defaults.avatarDicebearType : '',
          avatarUseGravatar: setupState.defaults?.avatarUseGravatar === true,
          trafficHistoryEnabled: setupState.defaults?.trafficHistoryEnabled === true,
          trafficSampleIntervalSeconds: Number.parseInt(setupState.defaults?.trafficSampleIntervalSeconds, 10) || 1,
          trafficRawRetentionHours: Number.parseInt(setupState.defaults?.trafficRawRetentionHours, 10) || 24,
          trafficMinuteRetentionDays: Number.parseInt(setupState.defaults?.trafficMinuteRetentionDays, 10) || 90,
          trafficHourRetentionDays: Number.parseInt(setupState.defaults?.trafficHourRetentionDays, 10) || 365,
        };

        if (this.setupState.needsSetup) {
          this.authenticated = false;
          this.requiresPassword = true;
          return;
        }

        const session = await this.api.getSession();
        this.authenticated = session.authenticated;
        this.requiresPassword = session.requiresPassword;
        this.refresh({
          updateCharts: this.updateCharts,
        }).catch((err) => {
          this.notifyError(err);
        });
        this.refreshClientIsolation().catch((err) => {
          this.notifyError(err);
        });
        this.refreshUplinkConfigOptions().catch((err) => {
          this.notifyError(err);
        });
        this.refreshUplinkSettings().catch((err) => {
          this.notifyError(err);
        });
        this.refreshUplinkProtectedCidrs().catch((err) => {
          this.notifyError(err);
        });
        this.refreshRoutingCategories().catch((err) => {
          this.notifyError(err);
        });
        this.refreshDnsRouting().catch((err) => {
          this.notifyError(err);
        });
        this.refreshSettings().catch((err) => {
          this.notifyError(err);
        });
        this.refreshDnsLogs().catch((err) => {
          this.notifyError(err);
        });
        this.loadAuthenticatedUiFlags().catch((err) => {
          this.notifyError(err);
        });
        this.loadAuthenticatedRuntimeInfo().catch((err) => {
          this.notifyError(err);
        });
        this.connectRealtime();
      })
      .catch((err) => {
        this.notifyError(err);
      });

    this.liveRefreshTimer = setInterval(() => {
      if (!this.authenticated) {
        return;
      }

      if (this.updateCharts && this.currentPage === 'clients') {
        this.refresh({
          updateCharts: true,
        }).catch(console.error);
      }

      if (this.currentPage === 'dns-logs') {
        this.refreshDnsLogs().catch(console.error);
      }
    }, 5000);

    const savedLang = localStorage.getItem('lang');
    if (savedLang && i18n.availableLocales.includes(savedLang)) {
      this.setLanguage(savedLang);
    } else {
      this.setLanguage('en');
    }
  },
  beforeDestroy() {
    this.disconnectRealtime();
    if (this.handleGlobalClick) {
      document.removeEventListener('click', this.handleGlobalClick);
      document.removeEventListener('touchstart', this.handleGlobalClick);
    }
    if (this.handleViewportChange) {
      window.removeEventListener('resize', this.handleViewportChange);
      window.removeEventListener('scroll', this.handleViewportChange, true);
    }
    if (this.handleHashChange) {
      window.removeEventListener('hashchange', this.handleHashChange);
    }
    if (this.notificationTimer) {
      clearTimeout(this.notificationTimer);
      this.notificationTimer = null;
    }
    if (this.liveRefreshTimer) {
      clearInterval(this.liveRefreshTimer);
      this.liveRefreshTimer = null;
    }
  },
  computed: {
    filteredClients() {
      if (!Array.isArray(this.clients)) return [];
      const q = (this.searchQuery || '').toLowerCase().trim();
      if (!q) return this.clients;
      return this.clients.filter((c) => {
        if ((c.name || '').toLowerCase().includes(q)) return true;
        if ((c.telegramId || '').toLowerCase().includes(q)) return true;
        if ((c.email || '').toLowerCase().includes(q)) return true;
        if (Array.isArray(c.groups) && c.groups.some((g) => (g || '').toLowerCase().includes(q))) return true;
        return false;
      });
    },
    sortedClients() {
      const list = [...this.filteredClients];
      const field = this.sortField;
      const asc = this.sortDirection === 'asc';
      if (field === 'expiredAt') {
        return list.sort((a, b) => {
          const aVal = a.expiredAt ? new Date(a.expiredAt).getTime() : Infinity;
          const bVal = b.expiredAt ? new Date(b.expiredAt).getTime() : Infinity;
          return asc ? aVal - bVal : bVal - aVal;
        });
      }
      if (field === 'createdAt') {
        return list.sort((a, b) => {
          const aVal = new Date(a.createdAt).getTime();
          const bVal = new Date(b.createdAt).getTime();
          return asc ? bVal - aVal : aVal - bVal;
        });
      }
      if (field === 'groups') {
        return list.sort((a, b) => {
          const aVal = (Array.isArray(a.groups) && a.groups[0] ? a.groups[0] : '').toLowerCase();
          const bVal = (Array.isArray(b.groups) && b.groups[0] ? b.groups[0] : '').toLowerCase();
          const cmp = aVal.localeCompare(bVal);
          return asc ? cmp : -cmp;
        });
      }
      return list.sort((a, b) => {
        const aVal = (a[field] || '').toString().toLowerCase();
        const bVal = (b[field] || '').toString().toLowerCase();
        const cmp = aVal.localeCompare(bVal);
        return asc ? cmp : -cmp;
      });
    },
    paginatedClients() {
      const start = (this.currentPageNum - 1) * this.pageSize;
      return this.sortedClients.slice(start, start + this.pageSize);
    },
    totalPages() {
      return Math.max(1, Math.ceil(this.filteredClients.length / this.pageSize));
    },
    paginationInfo() {
      const total = this.filteredClients.length;
      if (total === 0) return { start: 0, end: 0, total: 0 };
      const start = (this.currentPageNum - 1) * this.pageSize + 1;
      const end = Math.min(start + this.pageSize - 1, total);
      return { start, end, total };
    },
    timezoneOptions() {
      return [
        { value: 'Pacific/Honolulu', label: 'Гавайи (UTC−10:00)' },
        { value: 'America/Anchorage', label: 'Аляска (UTC−09:00)' },
        { value: 'America/Los_Angeles', label: 'Тихоокеанское время (UTC−08:00)' },
        { value: 'America/Denver', label: 'Горное время (UTC−07:00)' },
        { value: 'America/Chicago', label: 'Центральное время (UTC−06:00)' },
        { value: 'America/New_York', label: 'Восточное время (UTC−05:00)' },
        { value: 'America/Halifax', label: 'Атлантическое время (UTC−04:00)' },
        { value: 'America/Sao_Paulo', label: 'Бразилия (UTC−03:00)' },
        { value: 'Etc/GMT+2', label: 'UTC−02:00' },
        { value: 'Atlantic/Azores', label: 'Азорские острова (UTC−01:00)' },
        { value: 'UTC', label: 'UTC+00:00' },
        { value: 'Europe/London', label: 'Лондон, Дублин, Лиссабон (UTC+00:00)' },
        { value: 'Europe/Berlin', label: 'Берлин, Рим, Вена, Стокгольм (UTC+01:00)' },
        { value: 'Europe/Paris', label: 'Париж, Брюссель, Мадрид, Копенгаген (UTC+01:00)' },
        { value: 'Europe/Warsaw', label: 'Варшава, Прага, Будапешт, Загреб (UTC+01:00)' },
        { value: 'Europe/Athens', label: 'Афины, Бухарест (UTC+02:00)' },
        { value: 'Europe/Kyiv', label: 'Киев, Вильнюс, Рига, Хельсинки (UTC+02:00)' },
        { value: 'Europe/Kaliningrad', label: 'Калининград (UTC+02:00)' },
        { value: 'Europe/Moscow', label: 'Москва, Волгоград, СПб (UTC+03:00)' },
        { value: 'Europe/Minsk', label: 'Минск (UTC+03:00)' },
        { value: 'Asia/Baku', label: 'Баку (UTC+04:00)' },
        { value: 'Asia/Yerevan', label: 'Ереван (UTC+04:00)' },
        { value: 'Europe/Samara', label: 'Самара, Ижевск (UTC+04:00)' },
        { value: 'Asia/Tbilisi', label: 'Тбилиси (UTC+04:00)' },
        { value: 'Asia/Tashkent', label: 'Ташкент, Ашхабад (UTC+05:00)' },
        { value: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+05:00)' },
        { value: 'Asia/Almaty', label: 'Астана, Алматы (UTC+06:00)' },
        { value: 'Asia/Novosibirsk', label: 'Новосибирск (UTC+06:00)' },
        { value: 'Asia/Krasnoyarsk', label: 'Красноярск (UTC+07:00)' },
        { value: 'Asia/Shanghai', label: 'Пекин, Гонконг, Урумчи (UTC+08:00)' },
        { value: 'Asia/Irkutsk', label: 'Иркутск (UTC+08:00)' },
        { value: 'Asia/Singapore', label: 'Сингапур, Куала-Лумпур (UTC+08:00)' },
        { value: 'Asia/Yakutsk', label: 'Якутск (UTC+09:00)' },
        { value: 'Asia/Vladivostok', label: 'Владивосток, Магадан (UTC+10:00)' },
        { value: 'Asia/Srednekolymsk', label: 'Чокурдах (UTC+11:00)' },
        { value: 'Asia/Kamchatka', label: 'Петропавловск-Камчатский (UTC+12:00)' },
      ];
    },
    aclSelectorTypeOptions() {
      const options = [
        { value: 'all', label: this.$t('aclSelectorAll') },
        { value: 'client', label: this.$t('aclSelectorClient') },
        { value: 'cidr', label: this.$t('aclSelectorCidr') },
      ];

      if (Array.isArray(this.clientIsolation.availableGroups) && this.clientIsolation.availableGroups.length > 0) {
        options.splice(2, 0, { value: 'group', label: this.$t('aclSelectorGroup') });
      }

      return options;
    },
    aclActionOptions() {
      return [
        { value: 'allow', label: this.$t('aclActionAllow') },
        { value: 'deny', label: this.$t('aclActionDeny') },
      ];
    },
    chartOptionsTX() {
      const opts = {
        ...this.chartOptions,
        colors: [CHART_COLORS.tx[this.theme]],
      };
      opts.chart.type = UI_CHART_TYPES[this.uiChartType].type || false;
      opts.stroke.width = UI_CHART_TYPES[this.uiChartType].strokeWidth;
      return opts;
    },
    chartOptionsRX() {
      const opts = {
        ...this.chartOptions,
        colors: [CHART_COLORS.rx[this.theme]],
      };
      opts.chart.type = UI_CHART_TYPES[this.uiChartType].type || false;
      opts.stroke.width = UI_CHART_TYPES[this.uiChartType].strokeWidth;
      return opts;
    },
    updateCharts() {
      return this.uiChartType > 0 && this.uiShowCharts;
    },
    highlightedConfigText() {
      if (typeof this.configText !== 'string') {
        return '';
      }

      return this.configText
        .split('\n')
        .map((line) => this.highlightConfigLine(line))
        .join('\n');
    },
    trafficHistorySummaryCards() {
      if (!this.trafficHistory || !this.trafficHistory.summary) {
        return [];
      }

      const { summary, live } = this.trafficHistory;

      return [
        {
          label: this.$t('traffic.cards.downloaded'),
          value: this.formatBytesValue(summary.rxBytes),
          tone: 'blue',
        },
        {
          label: this.$t('traffic.cards.uploaded'),
          value: this.formatBytesValue(summary.txBytes),
          tone: 'red',
        },
        {
          label: this.$t('traffic.cards.maxDownloadRate'),
          value: this.formatRateValue(summary.maxRxRate),
          tone: 'sky',
        },
        {
          label: this.$t('traffic.cards.maxUploadRate'),
          value: this.formatRateValue(summary.maxTxRate),
          tone: 'rose',
        },
        {
          label: this.$t('traffic.cards.currentDownloadRate'),
          value: live ? this.formatRateValue(live.rxRate) : '0 B/s',
          tone: 'indigo',
        },
        {
          label: this.$t('traffic.cards.currentUploadRate'),
          value: live ? this.formatRateValue(live.txRate) : '0 B/s',
          tone: 'orange',
        },
      ];
    },
    trafficResolutionLabel() {
      if (!this.trafficHistory) {
        return '';
      }

      return this.$t(`traffic.resolution.${this.trafficHistory.resolution}`);
    },
    trafficSummaryHint() {
      if (!this.trafficHistory || !this.trafficHistory.summary) {
        return '';
      }

      return `${this.$t('traffic.samples')}: ${this.trafficHistory.summary.sampleCount}`;
    },
    trafficChartOptions() {
      const isDark = this.theme === 'dark';

      return {
        chart: {
          type: 'area',
          background: 'transparent',
          toolbar: {
            show: false,
          },
          zoom: {
            enabled: false,
          },
          animations: {
            enabled: false,
          },
          foreColor: isDark ? '#d4d4d8' : '#4b5563',
        },
        stroke: {
          curve: 'smooth',
          width: 2.5,
        },
        fill: {
          type: 'gradient',
          gradient: {
            shade: isDark ? 'dark' : 'light',
            shadeIntensity: 0.15,
            opacityFrom: isDark ? 0.34 : 0.28,
            opacityTo: 0.04,
            stops: [0, 100],
          },
        },
        dataLabels: {
          enabled: false,
        },
        markers: {
          size: 0,
          hover: {
            sizeOffset: 3,
          },
        },
        xaxis: {
          type: 'datetime',
          labels: {
            datetimeUTC: false,
            style: {
              colors: isDark ? '#a1a1aa' : '#6b7280',
            },
          },
          axisBorder: {
            show: false,
          },
          axisTicks: {
            show: false,
          },
        },
        yaxis: {
          labels: {
            formatter: (value) => this.formatBytesValue(value),
            style: {
              colors: isDark ? '#a1a1aa' : '#6b7280',
            },
          },
        },
        tooltip: {
          theme: isDark ? 'dark' : 'light',
          style: {
            fontSize: '12px',
          },
          x: {
            formatter: (_value, context) => {
              return this.dateTime(new Date(context.w.globals.seriesX[0][context.dataPointIndex]));
            },
          },
          y: {
            formatter: (value) => this.formatRateValue(value),
          },
        },
        grid: {
          borderColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(15,23,42,0.08)',
          strokeDashArray: 5,
        },
        legend: {
          show: false,
        },
      };
    },
    trafficRxChartOptions() {
      return {
        ...this.trafficChartOptions,
        colors: ['#2563eb'],
      };
    },
    trafficTxChartOptions() {
      return {
        ...this.trafficChartOptions,
        colors: ['#dc2626'],
      };
    },
    trafficRxChartSeries() {
      if (!this.trafficHistory) return [];

      const points = this.trafficHistory.series.map((point) => ({
        x: point.sampledAt.getTime(),
        y: point.rxRateAvg || point.rxRate || 0,
      }));

      return [{
        name: 'RX',
        data: this.downsampleTrafficSeries(points),
      }];
    },
    trafficTxChartSeries() {
      if (!this.trafficHistory) return [];

      const points = this.trafficHistory.series.map((point) => ({
        x: point.sampledAt.getTime(),
        y: point.txRateAvg || point.txRate || 0,
      }));

      return [{
        name: 'TX',
        data: this.downsampleTrafficSeries(points),
      }];
    },
    trafficRangeLabel() {
      if (!this.trafficHistory) {
        return '';
      }

      return `${this.dateTime(new Date(this.trafficHistory.sinceAt))} - ${this.dateTime(new Date(this.trafficHistory.untilAt))}`;
    },
    trafficLiveStats() {
      if (!this.trafficHistory || !this.trafficHistory.live) {
        return [];
      }

      const { live } = this.trafficHistory;

      return [
        {
          label: this.$t('traffic.currentDownloadRate'),
          value: this.formatRateValue(live.rxRate),
          tone: 'blue',
        },
        {
          label: this.$t('traffic.currentUploadRate'),
          value: this.formatRateValue(live.txRate),
          tone: 'red',
        },
        {
          label: this.$t('traffic.totalDownloaded'),
          value: this.formatBytesValue(live.rxTotal),
          tone: 'sky',
        },
        {
          label: this.$t('traffic.totalUploaded'),
          value: this.formatBytesValue(live.txTotal),
          tone: 'rose',
        },
      ];
    },
    navigationTabs() {
      return [
        { id: 'clients', label: this.$t('clients') },
        { id: 'acl', label: this.$t('clientIsolationNav') },
        { id: 'uplink', label: this.$t('uplinkNav') },
        { id: 'dns-logs', label: this.$t('dnsLogsNav') },
        { id: 'settings', label: this.$t('settingsNav') },
      ];
    },
    clientsOnlineCount() {
      return Array.isArray(this.clients)
        ? this.clients.filter((client) => this.clientIsOnline(client)).length
        : 0;
    },
    clientsGroupCount() {
      if (!Array.isArray(this.clientIsolation.availableGroups)) {
        return 0;
      }

      return this.clientIsolation.availableGroups.length;
    },
    clientSummaryCards() {
      return [
        {
          label: this.$t('totalClients'),
          value: String(Array.isArray(this.clients) ? this.clients.length : 0),
        },
        {
          label: this.$t('onlineClients'),
          value: String(this.clientsOnlineCount),
        },
        {
          label: this.$t('aclGroupsCount'),
          value: String(this.clientsGroupCount),
        },
        {
          label: this.$t('aclRulesCount'),
          value: String(this.aclEnabledRuleCount),
        },
      ];
    },
    aclEnabledRuleCount() {
      return Array.isArray(this.clientIsolation.rules)
        ? this.clientIsolation.rules.filter((rule) => rule.enabled).length
        : 0;
    },
    aclSummaryCards() {
      return [
        {
          label: this.$t('clientIsolationEnabled'),
          value: this.clientIsolation.enabled ? this.$t('statusOn') : this.$t('statusOff'),
        },
        {
          label: this.$t('aclRulesCount'),
          value: String(this.aclEnabledRuleCount),
        },
        {
          label: this.$t('aclGroupsCount'),
          value: String(Array.isArray(this.clientIsolation.availableGroups) ? this.clientIsolation.availableGroups.length : 0),
        },
      ];
    },
    uplinkSummaryCards() {
      const uplinks = Array.isArray(this.uplinks) ? this.uplinks : [];
      const enabledCount = uplinks.filter((uplink) => uplink.enabled).length;
      const sourceRuleCount = uplinks
        .flatMap((uplink) => uplink.sourceRulesText.split(/[\n,;]+/))
        .map((value) => value.trim())
        .filter(Boolean)
        .length;
      const domainRuleCount = uplinks
        .flatMap((uplink) => uplink.destinationDomainsText.split(/[\n,;]+/))
        .map((value) => value.trim())
        .filter(Boolean)
        .length;

      return [
        {
          label: this.$t('uplinkNav'),
          value: String(uplinks.length),
        },
        {
          label: this.$t('uplinkEnabled'),
          value: enabledCount > 0 ? this.$t('statusOn') : this.$t('statusOff'),
        },
        {
          label: this.$t('uplinkSources'),
          value: String(sourceRuleCount),
        },
        {
          label: this.$t('uplinkDomains'),
          value: String(domainRuleCount),
        },
        {
          label: this.$t('dnsRoutingNav'),
          value: this.dnsRouting.enabled ? this.$t('statusOn') : this.$t('statusOff'),
        },
      ];
    },
    uplinkSaveStatusLabel() {
      if (this.uplinkSaveState === 'saving' || this.uplinkSaving) {
        return this.$t('saving');
      }
      if (this.uplinkSaveState === 'saved') {
        return this.$t('uplinkAutosaveSaved');
      }
      if (this.uplinkSaveState === 'error') {
        return this.$t('uplinkAutosaveError');
      }
      if (this.uplinkSaveState === 'pending') {
        return this.$t('uplinkAutosavePending');
      }
      return '';
    },
    languageOptions() {
      return i18n.availableLocales.map((code) => ({
        code,
        label: LANGUAGE_LABELS[code] || code.toUpperCase(),
      }));
    },
    currentLanguageLabel() {
      const selected = this.languageOptions.find((lang) => lang.code === this.uiLanguage);
      return selected ? selected.label : this.uiLanguage.toUpperCase();
    },
    languageMenuStyle() {
      return {
        position: 'fixed',
        top: `${this.languageMenuPosition.top}px`,
        left: `${this.languageMenuPosition.left}px`,
        width: `${this.languageMenuPosition.width}px`,
        zIndex: 1000,
      };
    },
    theme() {
      if (this.uiTheme === 'auto') {
        return this.prefersDarkScheme.matches ? 'dark' : 'light';
      }
      return this.uiTheme;
    },
    isAllResolved() {
      return !this.dnsResolveStatus.running
        && this.dnsResolveStatus.lastResolved
        && this.dnsResolveStatus.processed >= this.dnsResolveStatus.total - this.dnsResolveStatus.errors
        && this.dnsResolveStatus.total > 0;
    },
  },
});
