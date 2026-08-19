# RedNetAmnezia

The easiest way to run **WireGuard VPN + AmneziaWG obfuscation** with a Web-based Admin UI, Telegram bot, and policy-based routing.

Fork of [wg-easy](https://github.com/wg-easy/wg-easy) with added support for **AmneziaWG** — an obfuscated WireGuard protocol that helps bypass DPI (Deep Packet Inspection) by adding junk packets, randomizing headers, and using advanced traffic masking techniques.

> [!WARNING]
> **AmneziaWG requires a custom client.** Standard WireGuard clients such as the official WireGuard app, WireGuard Go, tun2socks, or Tunsafe will **NOT** work because they use the standard handshake. You must use the [AmneziaVPN client](https://amnezia.org) or [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) to connect.

> [!NOTE]
> **AWG version** is controlled by `AMNEZIA_VERSION` env variable: `1.5` (basic obfuscation), `2` (adds CPS I1-I5 + DNS-mimic), or `3` (adds timers, ContentPadding, HeaderProtectionKey — enabled by default). The legacy `AMNEZIAWG_ENABLED=true` is still accepted (maps to v2) but deprecated.

---

## Features

### VPN & Protocol
- **AWG 1.5** — Jc, Jmin, Jmax, S1, S2, H1–H4 parameters
- **AWG 2.0** — adds S3, S4, I1–I5 CPS (init packet signatures); mimicry profile via `MIMICRY_PROFILE=dns|tls|quic|sip` (default `dns`)
- **AWG 3.0** — adds timers (RekeyAfterTime/RekeyTimeout/RejectAfterTime/KeepaliveTimeout/MaxHandshakeAttempts), ContentPaddingAddition, HeaderProtectionKey (on by default for v3; see client matrix below)
- Auto-generated non-overlapping H1–H4 ranges (spread across uint32 space for v2+)
- Auto S1/S2 with `S1+56 ≠ S2` constraint (Amnezia docs requirement)
- Userspace mode via `amneziawg-go` — no kernel module required
- Automatic iptables NAT and forwarding rules

### Web Admin UI
- Vue.js SPA with responsive design (mobile-friendly)
- Dashboard with client list, traffic charts (ApexCharts)
- QR code generation for client configs
- Direct config download / copy / one-time links (`/cnf/:link`)
- **AmneziaVPN `.vpn` file export** + `vpn://` key copy (v3 fields incl. HeaderProtectionKey carried via JSON container)
- Create, enable/disable, delete clients
- Per-client: name, address, email, Telegram ID, groups, expiration date, uplink assignment
- Traffic statistics per client (download/upload)
- Traffic history with raw (1s) / minute / hour aggregation
- Client expiration dates
- Dark / Light / Auto theme
- Multi-language: English, Russian

### Networking & Routing
- **Uplink tunnels** — multiple outbound WireGuard tunnels with policy-based routing (source + domain + CIDR)
- **Per-client uplink assignment** — route specific clients through specific tunnels
- **GeoSite integration** — auto-load domain lists from [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community), recursive `include:` resolution, cached locally, weekly auto-sync cron
- **GeoIP / CIDR routing** — IP-based routing via `ipset` with bulk `ipset restore` (88K+ CIDR capacity, `maxelem 131072`)
- **Protected CIDRs** — server/private networks that must never leave the main route
- **DNS routing** via built-in `dnsmasq` — transparent DNS proxy (iptables REDIRECT port 53), populates ipsets for domain-based routing
- **DNS Pre-resolve** — pre-resolves all domains to IPs, caches to JSON file, fills ipsets instantly on container restart without DNS queries
- **Client isolation (ACL)** — iptables-based inter-client firewall with group support
- **Routing categories** — admin-defined domain bundles, per-client toggles
- **Bypass** — route specific IPs/domains outside the VPN tunnel (e.g., local country resources)

### Security & Monitoring
- Password-protected Web UI (plain text or bcrypt hash)
- **Username + password auth** (`ADMIN_LOGIN` env var)
- **Configurable URL prefix** (`WEB_PATH` env var) — hide the panel behind a random path
- HTTPS/SSL support with custom certificates
- Session management with configurable max age (`MAX_AGE`)
- Prometheus metrics endpoint (`/metrics`, `/metrics/json`) with optional Basic Auth
- **API Key** — Bearer token authentication for external service integration (client management, uplinks, ACL, DNS)

### Telegram Bot
- Long-polling bot for client management
- Subscription-based access (200 ₽/30 days)
- Payment tracking with bank transfer details
- Grace period reminders
- QR code delivery via Telegram

### DevOps
- Docker multi-stage build (Node.js 18 + amneziawg-go base)
- Docker Compose for production deployment
- SQLite persistence for all settings and state
- **Multi-instance support** via `CONTAINER_SUFFIX`
- Backup / Restore configuration

---

## Quick Start

### 1. Prepare environment

```bash
# Copy example env file
cp .env_example .env

# Edit .env — set your external IP and passwords
nano .env
```

Minimal `.env` configuration:

```env
WG_HOST=your-server-ip-or-domain
PORT=51821
PASSWORD_HASH='your-bcrypt-hash'
WG_PORT=51820
WG_DEFAULT_ADDRESS=10.28.0.x
AMNEZIA_VERSION=2
```

### 2. Generate password hash (recommended)

```bash
# Using Node.js locally (in src/ directory):
node src/wgpw.mjs YOUR_PASSWORD

# Or via Docker:
docker run --rm -it rednetamnezia:latest node wgpw.mjs YOUR_PASSWORD
```

Copy the `PASSWORD_HASH` value into your `.env`. See [How_to_generate_an_bcrypt_hash.md](./How_to_generate_an_bcrypt_hash.md) for details.

### 3. Start the container

```bash
docker compose up -d
```

### 4. Access Web UI

Open `http://your-server-ip:51821` in your browser. On first run, you'll see a **first-run setup screen** where you configure the admin password, server host (WG_HOST), and default DNS.

If you set `WEB_PATH=mysecretpath`, the UI will be at `http://your-server-ip:51821/mysecretpath/`.

---

## Docker Compose

### Production (`docker-compose.yml`)

```yaml
services:
  awg:
    image: rednetamnezia:latest
    build:
      context: .
      args:
        AMNEZIA_VERSION: "${AMNEZIA_VERSION:-1.5}"
    container_name: rednetamnezia-v${AMNEZIA_VERSION:-2}${CONTAINER_SUFFIX}
    restart: unless-stopped
    privileged: true
    env_file:
      - .env
    volumes:
      - ./data:/etc/amnezia/amneziawg
      - /root/cert:/cert:ro
      - /etc/wireguard/uplinks:/etc/wireguard/uplinks:rw
    ports:
      - "${WG_PORT:-51820}:${WG_PORT:-51820}/udp"
      - "${PORT:-51821}:${PORT:-51821}/tcp"
    extra_hosts:
      - "api.telegram.org:149.154.167.220"
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      - net.ipv4.ip_forward=1
      - net.ipv4.conf.all.src_valid_mark=1
    networks:
      - rednet
    devices:
      - /dev/net/tun:/dev/net/tun

networks:
  rednet:
    name: rednet${CONTAINER_SUFFIX}
```

> **Note:** Omit the `build:` block when using a pre-built image. The `build.args.AMNEZIA_VERSION` is only needed when building locally — it controls which AWG patches are applied at build time.

---

## Environment Variables

Environment variables are split into **bootstrap** (must be in `.env` — affect container startup, ports, paths, networking) and **web-managed** (configured via Web UI → Settings, stored in SQLite). See [ENV_VARIABLES.md](./ENV_VARIABLES.md) for the full reference.

### 0. Container Settings

| Variable | Default | Description |
|---|---|---|
| `CONTAINER_SUFFIX` | — | Suffix for multi-instance deployments (affects container name + network name) |

### 1. Bootstrap — Required

| Variable | Default | Description |
|---|---|---|
| `WG_HOST` | — | Public IP or domain of the server |
| `PORT` | `51821` | TCP port for Web UI |
| `WEBUI_HOST` | `0.0.0.0` | Bind address for web server |
| `PASSWORD` | — | Admin password (plain text) |
| `PASSWORD_HASH` | — | Admin password (bcrypt hash, **recommended**) |
| `ADMIN_LOGIN` | — | Username for login (empty = password-only) |
| `WEB_PATH` | — | URL prefix for Web UI (e.g. `mypanel` → `/mypanel/`) |
| `REDIRECT_ROOT` | `true` | Redirect `/` to `/<WEB_PATH>/` (set `false` to disable) |
| `SERVICE_NAME` | `RenNetline` | Service name shown in UI header |
| `WG_PORT` | `51820` | UDP port for WireGuard |
| `WG_CONFIG_PORT` | (WG_PORT) | Port written in client configs (override if Docker port mapping differs) |
| `WG_MTU` | `1280` | MTU for clients |
| `WG_DEFAULT_ADDRESS` | `10.8.0.x` | Client IP subnet (e.g. `10.28.0.x`) |
| `WG_DEFAULT_DNS` | `1.1.1.1` | DNS server for clients |
| `WG_ALLOWED_IPS` | `0.0.0.0/0, ::/0` | AllowedIPs in client configs |
| `WG_PERSISTENT_KEEPALIVE` | `25` | PersistentKeepalive in client configs |
| `WG_DEVICE` | `eth0` | Outbound network interface |
| `WG_PATH` | `/etc/amnezia/amneziawg/` | Config, database, and state directory |
| `AMNEZIA_VERSION` | `1.5` | AWG protocol version: `1.5`, `2`, or `3` |
| `LANG` | `en` | UI language (`en`, `ru`) |
| `MAX_AGE` | `0` | Session lifetime in minutes (0 = session cookie) |

### 2. HTTPS / SSL

| Variable | Default | Description |
|---|---|---|
| `SSL_ENABLED` | `false` | Enable HTTPS |
| `SSL_CERT_PATH` | `/etc/ssl/certs/ssl-cert.pem` | Path to SSL certificate |
| `SSL_KEY_PATH` | `/etc/ssl/private/ssl-key.pem` | Path to SSL private key |

### 3. WireGuard Hooks / Host Networking

| Variable | Description |
|---|---|
| `WG_PRE_UP` | Command before WG starts |
| `WG_POST_UP` | Command after WG starts (default: built-in iptables NAT + forwarding) |
| `WG_PRE_DOWN` | Command before WG stops |
| `WG_POST_DOWN` | Command after WG stops (default: iptables cleanup) |
| `WG_UPLINK_CONFIGS_PATH` | Directory for uplink `.conf` files (default: `/etc/wireguard/uplinks`) |

### 4. Prometheus Metrics

| Variable | Default | Description |
|---|---|---|
| `ENABLE_PROMETHEUS_METRICS` | `false` | Enable `/metrics` and `/metrics/json` endpoints |
| `PROMETHEUS_METRICS_PASSWORD` | — | Basic Auth password for metrics (plain text) |
| `PROMETHEUS_METRICS_PASSWORD_HASH` | — | Basic Auth password for metrics (bcrypt hash) |

### 5. AmneziaWG Obfuscation

All obfuscation parameters are auto-generated if not set. Override only if you need fixed values.

| Variable | Type | Description |
|---|---|---|
| `JC` | int | Junk packet count (default: 3) |
| `JMIN` | int | Min junk packet size (auto: 35–50) |
| `JMAX` | int | Max junk packet size (auto: JMIN+20..60) |
| `S1` | int | Init packet junk size (auto: 15–150, constraint: S1+56 ≠ S2) |
| `S2` | int | Response packet junk size |
| `S3` | int | AWG 2.0+ cookie reply padding (auto: 8–55; v3 min 12) |
| `S4` | int | AWG 2.0+ data padding (auto: 4–27; v3 min 12) |
| `H1` | string | Magic header init packet (auto: non-overlapping range for v2+, single value for v1.5) |
| `H2` | string | Magic header response packet |
| `H3` | string | Magic header underload packet |
| `H4` | string | Magic header transport packet |
| `MIMICRY_PROFILE` | string | CPS mimicry profile for I1–I5: `dns` \| `tls` \| `quic` \| `sip` (default: `dns`). With `tls`/`quic`, I1 gets tls/quic and I2–I5 = dns |
| `MIMICRY_PROFILE_I1` | string | Profile for I1: `dns` \| `tls` \| `quic` \| `sip` (per-I, beats the global profile) |
| `MIMICRY_PROFILE_I2`–`MIMICRY_PROFILE_I5` | string | Profile for I2–I5: **only `dns` \| `sip`** — QUIC/TLS are I1-only (tls/quic → clamped to dns + warning) |
| `MIMICRY_BROWSER` | string | TLS fingerprint: `chrome` \| `firefox` \| `safari` (default: `chrome`; for `tls`/`quic`) |
| `MIMICRY_BROWSER_I1` | string | TLS fingerprint for I1 specifically (fallback: `MIMICRY_BROWSER`) |
| `MIMICRY_DOMAIN` | string | Explicit front domain (empty = `yandex.ru` for region=ru, else `yandex.com`) |
| `MIMICRY_REGION` | string | Front-domain pool: `world` \| `ru` (default: `world`) |
| `MIMICRY_ONLY_I1` | bool | Generate only I1 (default `false` — all I1–I5) |
| `I1`–`I5` | string | Explicit CPS values — always win over the profile (`''`/`0`/`null` = disabled) |
| `I_R_MIN` | int | Min `<r>` value for DNS packets (default: 2) |
| `I_R_MAX` | int | Max `<r>` value for DNS packets (default: 40 — see Known Issues) |
| `I1_DNS_SITES` | string | Comma-separated domain list for the dns profile (default: `icloud.com,google.com,nvidia.com`) |
| `I_DNS_MIMIC_ALL` | bool | dns-profile alias: I2–I5 also in DNS format (`false` by default) |

### 6. AWG 3.0 Parameters

Only active when `AMNEZIA_VERSION=3`. Format: `N` or `LO-HI` (uint16, HI ≥ LO).

| Variable | Default | Description |
|---|---|---|
| `HEADER_PROTECTION_KEY_ENABLE` | `true` (v3) | Header protection: on by default for v3, `false` to disable |
| `HEADER_PROTECTION_KEY` | auto | 44-char base64 key pin. Empty → generated once on first boot and persisted (stable across restarts). Changing it rotates the key: all clients must re-import configs |
| `CONTENT_PADDING_ADDITION` | **auto-random** | Content padding. Unset → generated randomly once on first boot (`8-24`–`48-96` bytes) and persisted |
| `REKEY_AFTER_TIME` | **auto-random** | Rekey-after time. Random around the 120s protocol default: `110-125`–`140-160` |
| `REKEY_TIMEOUT` | **auto-random** | Rekey timeout. Range `4-10` (around the 5s default) |
| `REJECT_AFTER_TIME` | **auto-random** | Reject-after time. Random around 180s: `175-190`–`200-215`, always `> RekeyAfterTime` |
| `KEEPALIVE_TIMEOUT` | **auto-random** | Keepalive timeout. Random around 10s: `9-14`–`20-30` |
| `MAX_HANDSHAKE_ATTEMPTS` | **auto-random** | Max handshake attempts. Random `16-20` (around the 18 default) |

Ranges are generated per the Amnezia 3.0 docs: `u16_range` format (`"N"` or `"LO-HI"`), the
daemon picks a random value inside the range (`UintRange.PickOne`). The invariant
**RejectAfterTime > RekeyAfterTime** always holds. An env pin of `(off)` removes the
field (protocol default) — the amneziawg parser itself does not implement `(off)`.
Timers are not must-match: changing them does not break clients; re-export to sync.

### 7. Traffic History

| Variable | Default | Description |
|---|---|---|
| `TRAFFIC_HISTORY_ENABLED` | `false` | Enable traffic history collection |
| `TRAFFIC_SAMPLE_INTERVAL_SECONDS` | `1` | Sampling interval |
| `TRAFFIC_RAW_RETENTION_HOURS` | `24` | Raw (1-second) data retention |
| `TRAFFIC_MINUTE_RETENTION_DAYS` | `90` | Minute-aggregated data retention |
| `TRAFFIC_HOUR_RETENTION_DAYS` | `365` | Hour-aggregated data retention |

### 8. Telegram Bot

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_ENABLED` | `false` | Enable Telegram bot |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from BotFather |
| `TELEGRAM_ADMIN_IDS` | — | Comma-separated admin Telegram user IDs |
| `TELEGRAM_BOT_POLL_TIMEOUT_SECONDS` | `25` | Long polling timeout |

### Deprecated Variables

| Deprecated | Replacement |
|---|---|
| `AMNEZIAWG_ENABLED=true` | `AMNEZIA_VERSION=2` |
| `PROMETHEUS_METRICS_PASSWORD_PLAIN` | `PROMETHEUS_METRICS_PASSWORD` |
| `PROMETHEUS_METRICS_PASSWORD_BCRYPT` | `PROMETHEUS_METRICS_PASSWORD_HASH` |

> Most settings can also be configured via **Web UI → Settings** after the initial setup. AWG obfuscation parameters, WG hooks, and networking bootstrap vars must stay in `.env`.

---

## AmneziaWG Obfuscation Reference

### Supported Parameters (per Amnezia Docs)

| Param | Range | Description |
|---|---|---|
| **Jc** | 0–10 | Junk packet count |
| **Jmin / Jmax** | 64–1024 | Junk packet size bounds |
| **S1** | 0–64 | Init packet padding |
| **S2** | 0–64 | Response packet padding |
| **S3** | 0–64 | Cookie Reply padding (v2+) |
| **S4** | 0–32 | Data padding (v2+) |
| **H1–H4** | 0–4,294,967,295 | Dynamic headers (v2+: non-overlapping ranges; v1.5: single values) |

### CPS Tags (I1–I5, v2+)

| Tag | Format | Limit | Description |
|---|---|---|---|
| `<b>` | `<b 0xHEX>` | arbitrary | Arbitrary bytes |
| `<r>` | `<r N>` | ≤ 1000 | Random bytes |
| `<rc>` | `<rc N>` | ≤ 1000 | Random bytes + CRC |
| `<rd>` | `<rd N>` | ≤ 1000 | Random bytes + duplicate header |
| `<t>` | — | — | **DO NOT USE** — causes handshake mismatch |

### Mimicry Profiles (`MIMICRY_PROFILE`)

I1–I5 are **decoys**: the handshake initiator sends them, the receiver never validates them.
The must-match set between server and client is **S1–S4, H1–H4, HeaderProtectionKey** only.
A profile change applies on restart (WireGuard.js migration): existing clients keep working,
re-export configs only to apply the new decoy profile to clients.

| Profile | Packet shape | I2–I5 |
|---|---|---|
| `dns` | DNS response with fake IP — `<r N><b 0xTXID+DNS_PAYLOAD>` (battle-proven; domains from `I1_DNS_SITES`) | `<b 0xHEX><r N>`; `I_DNS_MIMIC_ALL=true` → DNS format too |
| `tls` | TLS 1.2 ClientHello `<b 0xHEX>` with browser fingerprint (Chrome: GREASE+ALPS; Firefox: NSS order, padded to 512 bytes; Safari: SecureTransport, TLS 1.1 in supported_versions) | — (I1 only) |
| `quic` | QUIC v1 Initial `<b 0xHEX>` ~1200 bytes (CRYPTO frame with ClientHello, real RFC 9001 encryption) | — (I1 only) |
| `sip` | SIP REGISTER `<b 0xHEX>` (Via/From/To/Call-ID/User-Agent) | same domain |

**QUIC/TLS are I1-only, always.** I2–I5 can only be `dns`/`sip`:
- global `MIMICRY_PROFILE=tls|quic` → I1 = tls/quic, I2–I5 = **dns**
- per-I `MIMICRY_PROFILE_I2..I5=tls|quic` → clamped to `dns` + warning in the log
- `MIMICRY_PROFILE_I1` sets the I1 profile specifically (beats the global one);
  `MIMICRY_BROWSER_I1` sets the I1 fingerprint (fallback: `MIMICRY_BROWSER`)

- **Explicit `I1`–`I5`** in env always win over the profile
- **`MIMICRY_DOMAIN`** overrides the region pool (all profiles); unset → `yandex.ru` (region=ru) / `yandex.com`
- Large profiles (quic ~1200 bytes, firefox 512 bytes) may exceed QR capacity (~3 KB) —
  the panel shows a placeholder; use `.conf`/`.vpn` instead

### Auto-Generation Notes

- **H1–H4** for v2+ are spread evenly across the uint32 space as non-overlapping ranges with gaps (using `generateSpreadRanges`)
- **S1 + 56 ≠ S2** constraint is enforced per Amnezia documentation
- **`<r>` limit**: empirically, values above **40** break the handshake (as of 2026-08-10). Defaults: `I_R_MIN=2`, `I_R_MAX=40`
- **`<t>` tag** must never be used — it injects per-packet timestamps that cause handshake mismatch

---

## API Endpoints

### System / Info
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/release` | App release version |
| `GET` | `/api/service-info` | Service name + AWG version |
| `GET` | `/api/lang` | Current language setting |
| `GET` | `/api/events` | SSE stream for live UI updates |

### Session & Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/session` | Login |
| `GET` | `/api/session` | Check session status |
| `DELETE` | `/api/session` | Logout |

### Setup (first-run)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/setup-state` | Get setup status + defaults |
| `POST` | `/api/setup` | Save initial configuration |

### Settings
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Get all settings |
| `PUT` | `/api/settings` | Update settings |

### API Key
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/api-key` | Get API key (session required) |
| `POST` | `/api/api-key/regen` | Regenerate API key (session required) |

### WireGuard Clients
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wireguard/client` | List all clients |
| `POST` | `/api/wireguard/client` | Create a client |
| `DELETE` | `/api/wireguard/client/:clientId` | Delete a client |
| `POST` | `/api/wireguard/client/:clientId/enable` | Enable client |
| `POST` | `/api/wireguard/client/:clientId/disable` | Disable client |
| `POST` | `/api/wireguard/client/:clientId/generateOneTimeLink` | Generate one-time config link |
| `PUT` | `/api/wireguard/client/:clientId/name` | Update client name |
| `PUT` | `/api/wireguard/client/:clientId/address` | Update client address |
| `PUT` | `/api/wireguard/client/:clientId/email` | Update client email |
| `PUT` | `/api/wireguard/client/:clientId/expireDate` | Update expiration date |
| `PUT` | `/api/wireguard/client/:clientId/telegram-id` | Update Telegram ID |
| `PUT` | `/api/wireguard/client/:clientId/groups` | Update client groups |
| `PUT` | `/api/wireguard/client/:clientId/acl-groups` | Update ACL groups |
| `GET` | `/api/wireguard/client/:clientId/configuration` | Download `.conf` file |
| `GET` | `/api/wireguard/client/:clientId/vpn-config` | Download `.vpn` file (AmneziaVPN) |
| `GET` | `/api/wireguard/client/:clientId/vpn-key` | Get `vpn://` key |
| `GET` | `/api/wireguard/client/:clientId/qrcode.svg` | QR code (SVG) |
| `GET` | `/api/wireguard/client/:clientId/traffic` | Per-client traffic history |
| `POST` | `/api/wireguard/client-uplink-assignment` | Assign client to uplink |

### Traffic
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wireguard/traffic` | Overall traffic stats |

### Client Isolation (ACL)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wireguard/client-isolation` | Get isolation rules |
| `PUT` | `/api/wireguard/client-isolation` | Update isolation rules |

### Uplinks
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wireguard/uplinks` | List all uplinks |
| `PUT` | `/api/wireguard/uplinks` | Save uplink settings |
| `GET` | `/api/wireguard/uplink` | Get single uplink |
| `PUT` | `/api/wireguard/uplink` | Update single uplink |
| `GET` | `/api/wireguard/uplink-configs` | List available config files |
| `POST` | `/api/wireguard/uplink-configs` | Upload config file |
| `GET` | `/api/wireguard/uplink-protected-cidrs` | Get protected CIDRs |
| `PUT` | `/api/wireguard/uplink-protected-cidrs` | Update protected CIDRs |
| `POST` | `/api/wireguard/uplink/test` | Test uplink connection |
| `POST` | `/api/wireguard/uplink/:uplinkId/test` | Test specific uplink |
| `GET` | `/api/wireguard/uplink/geosite-status` | GeoSite data status |
| `POST` | `/api/wireguard/uplink/geosite-load` | Load GeoSite domains |
| `POST` | `/api/wireguard/uplink/geoip-load` | Load GeoIP CIDRs |
| `POST` | `/api/wireguard/uplink-domains-file` | Upload domain file for uplink |

### Routing Categories
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wireguard/routing-categories` | List routing categories |
| `PUT` | `/api/wireguard/routing-categories` | Update routing categories |
| `GET` | `/api/wireguard/client/:clientId/routing-categories` | Get client category toggles |
| `PUT` | `/api/wireguard/client/:clientId/routing-categories/:categoryId` | Toggle category for client |

### DNS Routing
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wireguard/dns-routing` | Get DNS routing config |
| `PUT` | `/api/wireguard/dns-routing` | Update DNS routing config |
| `GET` | `/api/wireguard/dns-routing/resolve-status` | Pre-resolve progress + ETA |
| `POST` | `/api/wireguard/dns-routing/resolve` | Start pre-resolve |
| `GET` | `/api/wireguard/dns-logs` | dnsmasq query log tail |

### Backup
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/wireguard/backup` | Download configuration backup |
| `PUT` | `/api/wireguard/restore` | Restore configuration from backup |

### Prometheus
| Method | Path | Description |
|---|---|---|
| `GET` | `/metrics` | Prometheus text format |
| `GET` | `/metrics/json` | JSON format with per-client rates |

### One-Time Config
| Method | Path | Description |
|---|---|---|
| `GET` | `/cnf/:clientOneTimeLink` | Download client config (no auth, single-use, 5-min expiry) |

---

## Known Issues & Limitations

| Issue | Status | Details |
|---|---|---|
| **HeaderProtectionKey (v3)** | ✅ Works | `.conf` for AmneziaWG 3.1+ (Android). For AmneziaVPN 5.0.0.5 use `.vpn`/`vpn://` only (JSON container). Enabling HPK invalidates existing client configs (must-match) — re-import required |
| **I2–I5 stability** | ⚠️ Disabled | Periodically break handshake with some client builds. Disabled by default (empty in `.env`); use I1-only if issues appear |
| **Large I packets** | ⚠️ Documented | QUIC I1 ~1200 bytes, Firefox I1 512 bytes: pumbaX experience — "mobile AWG does not always deliver (especially I5)". On mobile issues use `MIMICRY_ONLY_I1=true` or the `dns` profile |
| **`<r>` limit** | ⚠️ Documented | Values above **40** break handshake (empirical, as of 2026-08-10). Controlled by `I_R_MIN=2`, `I_R_MAX=40` |
| **`<t>` CPS tag** | ❌ Forbidden | Never use — injects per-packet timestamps that cause handshake mismatch |
| **Manual iptables** | ⚠️ Required | Inter-server uplink tunnels need manual FORWARD + MASQUERADE rules after container restart (or use `WG_PRE_UP`/`WG_POST_UP` hooks) |
| **AmneziaVPN + `.conf`** | ❌ Client bug | AmneziaVPN ≤5.0.0.5 silently drops v3 fields on `.conf` import ([amnezia-client#2942](https://github.com/amnezia-vpn/amnezia-client/issues/2942)) — use `.vpn`/`vpn://` |
| **AmneziaWG for Windows 2.0.2** | ❌ No v3 | Released before the v3 protocol — no HPK parser; use a v2 container for Windows, or AmneziaVPN with `vpn://` |

---

## Project Structure

```
├── Dockerfile                  # Multi-stage build (Node.js + amneziawg-go)
├── docker-compose.yml          # Production deployment
├── entrypoint-with-ui.sh       # Container entrypoint (AWG setup + Node.js)
├── wireguard-patch.sh          # AWG 2.0/3.0 patching script (build time)
├── .env_example                # Environment variables template
├── ENV_VARIABLES.md            # Full environment variable reference
├── How_to_generate_an_bcrypt_hash.md
│
├── src/
│   ├── server.js               # Application entry point
│   ├── config.js               # Environment config + AWG param generation
│   ├── wgpw.mjs / wgpw.sh      # bcrypt hash generator utilities
│   ├── services/
│   │   ├── Server.js           # HTTP/HTTPS server (h3 framework)
│   │   ├── WireGuard.js        # WireGuard management service
│   │   └── TelegramBot.js      # Telegram bot service
│   ├── lib/
│   │   ├── Server.js           # Server implementation (API routes, auth, setup)
│   │   ├── WireGuard.js        # WG config generator, client management, uplinks, DNS
│   │   ├── TelegramBot.js      # Bot logic (polling, payments, subscriptions)
│   │   ├── ConfigStore.js      # SQLite-based configuration store
│   │   ├── TelegramStore.js    # SQLite store for Telegram state
│   │   ├── TrafficHistory.js   # Traffic data collection & aggregation
│   │   ├── Util.js             # Utility functions
│   │   ├── ServerError.js      # Error handling
│   │   └── db/
│   │       ├── SqliteMigrator.js
│   │       └── migrations/     # SQLite schema migrations
│   └── www/                    # Web UI (Vue.js SPA)
│       ├── index.html          # Main SPA page
│       ├── login.html          # Login page
│       ├── manifest.json       # PWA manifest
│       ├── js/
│       │   ├── app.js          # Vue.js application (~2700 lines)
│       │   ├── api.js          # API client
│       │   ├── i18n.js         # Internationalization (EN + RU)
│       │   └── vendor/         # Third-party libraries
│       ├── css/                # Compiled CSS
│       └── img/                # Icons, logos
│
├── bypass/                     # GeoIP / GeoSite data files
│   ├── geoip/
│   └── geosite/
├── uplinks/                    # Uplink tunnel configs
├── data/                       # Runtime state (mounted volume)
├── backups/                    # Configuration backups
└── cert/                       # SSL certificates (mounted volume)
```

---

## Build & Development

### Build Docker image

```bash
docker build -t rednetamnezia .
# or with version:
docker build --build-arg AMNEZIA_VERSION=3 -t rednetamnezia .
```

### Local development (without Docker)

```bash
cd src
npm ci
npm run serve              # with nodemon (hot reload)
npm run serve-with-password  # with PASSWORD=wg
```

### Run tests

```bash
cd src
npm test
```

### Rebuild CSS

```bash
cd src
npm run buildcss           # recompile Tailwind CSS
```

---

## Clients

You must use an **AmneziaWG-compatible client** to connect:

| Platform | Client | AWG 3.0 (HPK) |
|---|---|---|
| Windows / macOS / Linux | [AmneziaVPN](https://amnezia.org) | ✅ via `.vpn`/`vpn://` (`.conf` import breaks v3 — amnezia-client#2942) |
| Android | [AmneziaWG for Android](https://github.com/amnezia-vpn/amneziawg-android) 3.1+ | ✅ via `.conf` (build from source; Play 2.0.1 doesn't support v3) |
| Android | [AmneziaVPN for Android](https://play.google.com/store/apps/details?id=org.amnezia.vpn) | ✅ via `.vpn`/`vpn://` |
| iOS | [AmneziaVPN for iOS](https://apps.apple.com/app/amnezia-vpn/id1600529900) | ✅ via `.vpn`/`vpn://` |
| Windows | AmneziaWG for Windows 2.0.2 | ❌ no HPK parser — use a v2 container |
| Linux CLI | [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) 3.x | ✅ via `.conf` |

Standard WireGuard clients (official WireGuard app, WireGuard Go, TunSafe, etc.) are **not compatible** due to the custom obfuscated handshake.

---

## License

This project is licensed under [CC BY-NC-SA 4.0](./LICENSE) — Attribution-NonCommercial-ShareAlike 4.0 International.

Original [wg-easy](https://github.com/wg-easy/wg-easy) by Emile Nijssen.
