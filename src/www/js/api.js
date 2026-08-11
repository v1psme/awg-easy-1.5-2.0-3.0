/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */

'use strict';

class API {

  async call({ method, path, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(`./api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body
        ? JSON.stringify(body)
        : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status === 204) {
      return undefined;
    }

    const json = await res.json();

    if (!res.ok) {
      throw new Error(json.error || json.statusMessage || json.message || res.statusText);
    }

    return json;
  }

  async getRelease() {
    return this.call({
      method: 'get',
      path: '/release',
    });
  }

  async getLang() {
    return this.call({
      method: 'get',
      path: '/lang',
    });
  }

  async getRememberMeEnabled() {
    return this.call({
      method: 'get',
      path: '/remember-me',
    });
  }

  async getuiTrafficStats() {
    return this.call({
      method: 'get',
      path: '/ui-traffic-stats',
    });
  }

  async getChartType() {
    return this.call({
      method: 'get',
      path: '/ui-chart-type',
    });
  }

  async getWGEnableOneTimeLinks() {
    return this.call({
      method: 'get',
      path: '/wg-enable-one-time-links',
    });
  }

  async getWGEnableExpireTime() {
    return this.call({
      method: 'get',
      path: '/wg-enable-expire-time',
    });
  }

  async getAvatarSettings() {
    return this.call({
      method: 'get',
      path: '/ui-avatar-settings',
    });
  }

  async getSession() {
    return this.call({
      method: 'get',
      path: '/session',
    });
  }

  async getSetupState() {
    return this.call({
      method: 'get',
      path: '/setup-state',
    });
  }

  async createSetup({ password, wgHost, defaultDns, runtime }) {
    return this.call({
      method: 'post',
      path: '/setup',
      body: { password, wgHost, defaultDns, runtime },
    });
  }

  async createSession({ password, remember }) {
    return this.call({
      method: 'post',
      path: '/session',
      body: { password, remember },
    });
  }

  async deleteSession() {
    return this.call({
      method: 'delete',
      path: '/session',
    });
  }

  async getSettings() {
    return this.call({
      method: 'get',
      path: '/settings',
    });
  }

  async updateSettings({ wgHost, defaultDns, runtime, newPassword, telegram }) {
    return this.call({
      method: 'put',
      path: '/settings',
      body: { wgHost, defaultDns, runtime, newPassword, telegram },
    });
  }

  async getClients() {
    return this.call({
      method: 'get',
      path: '/wireguard/client',
    }).then((clients) => clients.map((client) => ({
      ...client,
      createdAt: new Date(client.createdAt),
      updatedAt: new Date(client.updatedAt),
      expiredAt: client.expiredAt !== null
        ? new Date(client.expiredAt)
        : null,
      latestHandshakeAt: client.latestHandshakeAt !== null
        ? new Date(client.latestHandshakeAt)
        : null,
    })));
  }

  async getClientIsolation() {
    return this.call({
      method: 'get',
      path: '/wireguard/client-isolation',
    });
  }

  async getUplinkSettings() {
    return this.call({
      method: 'get',
      path: '/wireguard/uplink',
    });
  }

  async getUplinks() {
    return this.call({
      method: 'get',
      path: '/wireguard/uplinks',
    });
  }

  async getUplinkConfigs() {
    return this.call({
      method: 'get',
      path: '/wireguard/uplink-configs',
    });
  }

  async getUplinkProtectedCidrs() {
    return this.call({
      method: 'get',
      path: '/wireguard/uplink-protected-cidrs',
    });
  }

  async uploadUplinkConfig({ filename, content }) {
    return this.call({
      method: 'post',
      path: '/wireguard/uplink-configs',
      body: { filename, content },
    });
  }

  async getClientConfiguration({ clientId }) {
    const res = await fetch(`./api/wireguard/client/${clientId}/configuration`);

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json();
        throw new Error(json.error || res.statusText);
      }

      throw new Error(await res.text() || res.statusText);
    }

    return res.text();
  }

  async getClientVpnKey({ clientId }) {
    const res = await fetch(`./api/wireguard/client/${clientId}/vpn-key`);

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json();
        throw new Error(json.error || res.statusText);
      }
      throw new Error(await res.text() || res.statusText);
    }

    return res.text();
  }

  async getClientVpnConfig({ clientId }) {
    const res = await fetch(`./api/wireguard/client/${clientId}/vpn-config`);

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json();
        throw new Error(json.error || res.statusText);
      }

      throw new Error(await res.text() || res.statusText);
    }

    return res.text();
  }

  async getClientTraffic({ clientId, period }) {
    return this.call({
      method: 'get',
      path: `/wireguard/client/${clientId}/traffic?period=${encodeURIComponent(period)}`,
    });
  }

  async getTrafficOverview() {
    return this.call({
      method: 'get',
      path: '/wireguard/traffic',
    });
  }

  async createClient({ name, expiredDate }) {
    return this.call({
      method: 'post',
      path: '/wireguard/client',
      body: { name, expiredDate },
    });
  }

  async deleteClient({ clientId }) {
    return this.call({
      method: 'delete',
      path: `/wireguard/client/${clientId}`,
    });
  }

  async showOneTimeLink({ clientId }) {
    return this.call({
      method: 'post',
      path: `/wireguard/client/${clientId}/generateOneTimeLink`,
    });
  }

  async enableClient({ clientId }) {
    return this.call({
      method: 'post',
      path: `/wireguard/client/${clientId}/enable`,
    });
  }

  async disableClient({ clientId }) {
    return this.call({
      method: 'post',
      path: `/wireguard/client/${clientId}/disable`,
    });
  }

  async updateClientName({ clientId, name }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/name/`,
      body: { name },
    });
  }

  async updateClientAddress({ clientId, address }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/address/`,
      body: { address },
    });
  }

  async updateClientAclGroups({ clientId, aclGroups }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/acl-groups/`,
      body: { aclGroups },
    });
  }

  async updateClientExpireDate({ clientId, expireDate }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/expireDate/`,
      body: { expireDate },
    });
  }

  async updateClientEmail({ clientId, email }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/email/`,
      body: { email },
    });
  }

  async updateClientTelegramId({ clientId, telegramId }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/telegram-id/`,
      body: { telegramId },
    });
  }

  async updateClientGroups({ clientId, groups }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/groups/`,
      body: { groups },
    });
  }

  async setClientUplink({ clientId, uplinkId }) {
    return this.call({
      method: 'post',
      path: '/wireguard/client-uplink-assignment',
      body: { clientId, uplinkId },
    });
  }

  async updateClientIsolation({ enabled, rules }) {
    return this.call({
      method: 'put',
      path: '/wireguard/client-isolation',
      body: { enabled, rules },
    });
  }

  async updateUplinkSettings({
    id,
    name,
    enabled,
    configPath,
    interfaceName,
    table,
    geoSiteSync,
    geoIpSync,
    sourceRules,
    destinationDomains,
    destinationIps,
  }) {
    return this.call({
      method: 'put',
      path: '/wireguard/uplink',
      body: {
        id,
        name,
        enabled,
        configPath,
        interfaceName,
        table,
        geoSiteSync,
        geoIpSync,
        sourceRules,
        destinationDomains,
        destinationIps,
      },
    });
  }

  async loadGeoIp() {
    return this.call({ method: 'post', path: '/wireguard/uplink/geoip-load' });
  }

  async getGeoSiteStatus() {
    return this.call({
      method: 'get',
      path: '/wireguard/uplink/geosite-status',
    });
  }

  async loadGeoSite({ categoryName } = {}) {
    return this.call({
      method: 'post',
      path: '/wireguard/uplink/geosite-load',
      body: { categoryName },
    });
  }

  async updateUplinks({ uplinks }) {
    return this.call({
      method: 'put',
      path: '/wireguard/uplinks',
      body: { uplinks },
    });
  }

  async updateUplinkProtectedCidrs({ cidrs }) {
    return this.call({
      method: 'put',
      path: '/wireguard/uplink-protected-cidrs',
      body: { cidrs },
    });
  }

  async getRoutingCategories() {
    return this.call({
      method: 'get',
      path: '/wireguard/routing-categories',
    });
  }

  async updateRoutingCategories({ categories }) {
    return this.call({
      method: 'put',
      path: '/wireguard/routing-categories',
      body: { categories },
    });
  }

  async getDnsRouting() {
    return this.call({
      method: 'get',
      path: '/wireguard/dns-routing',
    });
  }

  async getDnsLogs(limit = 200) {
    return this.call({
      method: 'get',
      path: `/wireguard/dns-logs?limit=${encodeURIComponent(limit)}`,
    });
  }

  async updateDnsRouting({ enabled, resolveEnabled, upstreams }) {
    return this.call({
      method: 'put',
      path: '/wireguard/dns-routing',
      body: { enabled, resolveEnabled, upstreams },
    });
  }

  async getDnsResolveStatus() {
    return this.call({
      method: 'get',
      path: '/wireguard/dns-routing/resolve-status',
    });
  }

  async startDnsResolve() {
    return this.call({
      method: 'post',
      path: '/wireguard/dns-routing/resolve',
    });
  }

  async testUplinkConnection(uplinkId = null) {
    return this.call({
      method: 'post',
      path: uplinkId
        ? `/wireguard/uplink/${encodeURIComponent(uplinkId)}/test`
        : '/wireguard/uplink/test',
    });
  }

  async restoreConfiguration(file) {
    return this.call({
      method: 'put',
      path: '/wireguard/restore',
      body: { file },
    });
  }

  async getUiSortClients() {
    return this.call({
      method: 'get',
      path: '/ui-sort-clients',
    });
  }

}
