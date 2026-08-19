# ENV Variables

Список переменных окружения для `amnezia-wg-easy` с разделением на:

- bootstrap env: нужны до старта контейнера/HTTP-сервера и должны оставаться в `.env`
- web-managed settings: могут жить в SQLite и настраиваются через initial setup / Settings в Web UI

## Bootstrap env

Эти параметры относятся к запуску контейнера, bind/listen, путям, сертификатам и host integration.

### Core bootstrap

| Variable | Default | Example | Description |
|---|---|---|---|
| `PORT` | `51821` | `443` | TCP-порт Web UI/HTTPS. |
| `WEBUI_HOST` | `0.0.0.0` | `127.0.0.1` | Адрес bind для web-сервера. |
| `WG_PATH` | `/etc/wireguard/` | `/etc/wireguard/` | Каталог конфигов, SQLite, backup и runtime state. |
| `WG_DEVICE` | `eth0` | `ens6f0` | Интерфейс для NAT/маршрутизации. |
| `LANG` | `en` | `ru` | Начальный язык UI. |
| `MAX_AGE` | `0` | `1440` | Время жизни сессии (минуты). |
| `WEB_PATH` | `''` | `mypanel` | Префикс пути для всего веб-интерфейса. По умолчанию пусто — UI доступен в корне `/`. Если задать `mypanel`, UI будет доступен по пути `http://host:port/mypanel/`. |
| `ADMIN_LOGIN` | `''` | `admin` | Имя пользователя для входа в веб-интерфейс. По умолчанию пусто — требуется только пароль. Если задано, на странице логина появится поле "Логин". |

### HTTPS bootstrap

| Variable | Default | Example | Description |
|---|---|---|---|
| `SSL_ENABLED` | `false` | `true` | Включить HTTPS. |
| `SSL_CERT_PATH` | `/etc/ssl/certs/ssl-cert.pem` | `/etc/letsencrypt/live/example.com/fullchain.pem` | Путь к сертификату внутри контейнера. |
| `SSL_KEY_PATH` | `/etc/ssl/private/ssl-key.pem` | `/etc/letsencrypt/live/example.com/privkey.pem` | Путь к приватному ключу внутри контейнера. |

### Hooks / host networking bootstrap

| Variable | Default | Example | Description |
|---|---|---|---|
| `WG_PRE_UP` | `''` | `...` | Команда перед запуском WG. |
| `WG_POST_UP` | built-in iptables | `...` | Команда после запуска WG. |
| `WG_PRE_DOWN` | `''` | `...` | Команда перед остановкой WG. |
| `WG_POST_DOWN` | built-in iptables | `...` | Команда после остановки WG. |
| `WG_UPLINK_CONFIGS_PATH` | `/etc/wireguard/uplinks` | `/etc/wireguard/uplinks` | Каталог uplink `.conf` внутри контейнера. |

### Prometheus bootstrap

| Variable | Default | Example | Description |
|---|---|---|---|
| `ENABLE_PROMETHEUS_METRICS` | `false` | `true` | Включить `/metrics` и `/metrics/json`. |
| `PROMETHEUS_METRICS_PASSWORD` | - | `metricsPass123` | Пароль Basic Auth для `/metrics*` (plain text). |
| `PROMETHEUS_METRICS_PASSWORD_HASH` | - | `$2y$05$...` | Bcrypt-хеш пароля Basic Auth для `/metrics*`. |

Notes:

- Можно задать и `PROMETHEUS_METRICS_PASSWORD`, и `PROMETHEUS_METRICS_PASSWORD_HASH`; авторизация примет любой.

### Deprecated aliases

| Variable | Replaced by |
|---|---|
| `PROMETHEUS_METRICS_PASSWORD_PLAIN` | `PROMETHEUS_METRICS_PASSWORD` |
| `PROMETHEUS_METRICS_PASSWORD_BCRYPT` | `PROMETHEUS_METRICS_PASSWORD_HASH` |

### AmneziaWG obfuscation bootstrap

| Variable | Default | Example | Description |
|---|---|---|---|
| `JC` | random | `5` | Количество junk-пакетов. |
| `JMIN` | `50` | `25` | Минимальный размер junk-пакета. |
| `JMAX` | `1000` | `250` | Максимальный размер junk-пакета. |
| `S1` | random | `75` | Размер junk-данных в init packet. |
| `S2` | random | `75` | Размер junk-данных в response packet. |
| `H1` | random | `1234567891` | Magic header init packet. |
| `H2` | random | `1234567892` | Magic header response packet. |
| `H3` | random | `1234567893` | Magic header underload packet. |
| `H4` | random | `1234567894` | Magic header transport packet. |
| `S3` | random | `18` | Padding Cookie Reply (v2+; v3 мин. 12 при HPK). |
| `S4` | random | `20` | Padding данных (v2+; v3 мин. 12 при HPK). |

### Мимикрия CPS (I1–I5, v2/v3)

| Variable | Default | Description |
|---|---|---|
| `MIMICRY_PROFILE` | `dns` | Глобальный профиль: `dns\|tls\|quic\|sip`. При `tls`/`quic` I2–I5 = dns |
| `MIMICRY_PROFILE_I1` | — | Профиль для I1: `dns\|tls\|quic\|sip` (бьёт глобальный) |
| `MIMICRY_PROFILE_I2`–`MIMICRY_PROFILE_I5` | — | Профиль для I2–I5: **только `dns\|sip`** (tls/quic → clamp к dns + warning; QUIC/TLS разрешены только для I1) |
| `MIMICRY_BROWSER` | `chrome` | Браузерный отпечаток tls/quic: `chrome\|firefox\|safari` |
| `MIMICRY_BROWSER_I1` | = `MIMICRY_BROWSER` | Отпечаток именно для I1 |
| `MIMICRY_DOMAIN` | `yandex.ru`/`yandex.com` | Явный фронт-домен (default по региону: ru → yandex.ru) |
| `MIMICRY_REGION` | `world` | Пул доменов: `world\|ru` |
| `MIMICRY_ONLY_I1` | `false` | Генерировать только I1 |
| `I1`–`I5` | — | Явные CPS-значения, всегда побеждают (`''`/`0`/`null` = отключено) |
| `I1_DNS_SITES` | `icloud.com,google.com,nvidia.com` | Пул доменов dns-профиля |
| `I_R_MIN` / `I_R_MAX` | `2` / `40` | Диапазон `<r>` для DNS-пакетов (>40 ломает handshake) |
| `I_DNS_MIMIC_ALL` | `false` | Alias dns-профиля (только в legacy-пути dns; в per-I dns всегда полный формат) |

Приоритет: явные `I1..I5` > `MIMICRY_PROFILE_I1..I5` > `MIMICRY_PROFILE`.
I1–I5 — декои, не must-match: смена профиля клиентов не ломает, переэкспорт — для применения.

### AWG 3.0 таймеры и padding (только при `AMNEZIA_VERSION=3`)

| Variable | Default | Description |
|---|---|---|
| `HEADER_PROTECTION_KEY_ENABLE` | `true` | Защита заголовков (false — выключить) |
| `HEADER_PROTECTION_KEY` | авто | 44-char base64 пин. Пусто → генерируется один раз + персист; смена = ротация (клиенты переимпортируют) |
| `CONTENT_PADDING_ADDITION` | **авто-рандом** | `8-24`–`48-96` байт |
| `REKEY_AFTER_TIME` | **авто-рандом** | `110-125`–`140-160` сек (дефолт протокола 120с) |
| `REKEY_TIMEOUT` | **авто-рандом** | `4-10` сек (дефолт 5с) |
| `REJECT_AFTER_TIME` | **авто-рандом** | `175-190`–`200-215` сек (дефолт 180с; всегда > RekeyAfterTime) |
| `KEEPALIVE_TIMEOUT` | **авто-рандом** | `9-14`–`20-30` сек (дефолт 10с) |
| `MAX_HANDSHAKE_ATTEMPTS` | **авто-рандом** | `16-20` (дефолт 18) |

Формат: `N` или `LO-HI` (uint16, HI ≥ LO); демон выбирает значение внутри диапазона случайно.
Не задано → рандом один раз при первом старте + персист в БД (стабилен между рестартами).
Пин `(off)` = убрать поле (протокольный дефолт) — парсер amneziawg `(off)` не поддерживает.
Таймеры не must-match: смена не ломает клиентов, переэкспорт для синхронизации.

## Web-managed settings

Эти параметры можно больше не держать обязательными в `.env`.
Они настраиваются через:

- initial setup при первом запуске
- `Settings` в Web UI

Их effective state хранится в SQLite.

### Auth / setup

| Setting | Source | Description |
|---|---|---|
| Admin password | Web UI | Пароль админки задаётся в initial setup или меняется в Settings. |
| `WG_HOST` | Web UI | Публичный IP/домен сервера. Поддерживается `auto`. |
| `WG_DEFAULT_DNS` | Web UI | DNS для клиентов. |

Notes:

- Старые `PASSWORD` / `PASSWORD_HASH` из env всё ещё поддерживаются как fallback/bootstrap, но основной путь теперь через setup/settings.

### WireGuard runtime

| Setting | Default | Description |
|---|---|---|
| `WG_PORT` | `51820` | UDP-порт WireGuard. |
| `WG_CONFIG_PORT` | `WG_PORT` | Порт, который попадает в клиентские конфиги (`Endpoint`). |
| `WG_MTU` | `null` | MTU клиентов. |
| `WG_PERSISTENT_KEEPALIVE` | `0` | PersistentKeepalive в секундах. |
| `WG_DEFAULT_ADDRESS` | `10.8.0.x` | Подсеть клиентов. |
| `WG_ALLOWED_IPS` | `0.0.0.0/0, ::/0` | AllowedIPs клиентов. |

### Uplink / DNS routing

| Setting | Default | Description |
|---|---|---|
| `WG_DNS_ROUTING_ENABLED` | `false` | Встроенный VPN DNS (`dnsmasq`) и redirect `53/tcp+udp`. |
| `WG_DNS_ROUTING_UPSTREAMS` | `WG_DEFAULT_DNS` | Upstream DNS для встроенного VPN DNS. |
| `WG_UPLINK_ENABLED` | `false` | Базовый uplink fallback из env для первого старта. |
| `WG_UPLINK_CONFIG_PATH` | `''` | Базовый uplink config path для первого старта. |
| `WG_UPLINK_INTERFACE` | `''` | Базовый uplink interface для первого старта. |
| `WG_UPLINK_TABLE` | `200` | Базовая routing table для первого старта. |
| `WG_UPLINK_SOURCE_RULES` | `''` | Базовые source rules для первого старта. |

Notes:

- После первого старта uplinks, DNS routing, routing categories и ACL уже управляются через Web UI.
- `WG_UPLINK_CONFIG_PATH` должен указывать на полноценный `wg-quick` конфиг uplink-туннеля.
- В uplink-конфиге обязательно должно быть `Table = off`.
- `WG_UPLINK_SOURCE_RULES` принимает IPv4 адреса или CIDR.
- В uplink table копируются non-default IPv4 маршруты из `main`, чтобы policy-routed клиенты не теряли доступ к локальным сетям контейнера.
- Через UI поддерживаются несколько uplink-туннелей, их порядок и domain-based routing.

### GeoSite sync

| Setting | Default | Description |
|---|---|---|
| `WG_BYPASS_GEOSITE` | `category-ru` | Категории GeoSite для авто-загрузки (через запятую). |
| `GEOSITE_DATA_PATH` | `/app/bypass/geosite-data` | Путь к git-клону GeoSite данных. |
| `GEOSITE_GIT_REPO` | `https://github.com/v2fly/domain-list-community.git` | Git-репозиторий с GeoSite-данными. |

Notes:
- При первом запуске кнопка «Загрузить с GeoSite» делает `git clone` репозитория.
- Рекурсивно разрешаются `include:` директивы.
- Результат кешируется в `/app/bypass/geosite/<category>.txt`.
- Крон 2 раза в неделю делает `git pull` и обновляет домены.
- Галочка «Авто-загрузка» в настройках uplink включает авто-обновление при старте.
- IP резолвятся и добавляются в ipsets через dnsmasq.
- Можно включить DNS Pre-resolve чтобы закешировать IP и заполнять ipsets мгновенно.

### UI features

| Setting | Default | Description |
|---|---|---|
| `UI_TRAFFIC_STATS` | `false` | Расширенная статистика RX/TX в UI. |
| `UI_CHART_TYPE` | `0` | Тип графиков в UI (`0/1/2/3`). |
| `UI_ENABLE_SORT_CLIENTS` | `false` | Сортировка клиентов в UI. |
| `WG_ENABLE_ONE_TIME_LINKS` | `false` | One-time ссылки на конфиг. |
| `WG_ENABLE_EXPIRES_TIME` | `false` | Истечение срока действия клиентов. |
| `DICEBEAR_TYPE` | `false` | Тип аватаров DiceBear. |
| `USE_GRAVATAR` | `false` | Использовать Gravatar. |

### Telegram bot

| Setting | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_ENABLED` | `false` | Включить Telegram bot с long polling. |
| `TELEGRAM_BOT_TOKEN` | `''` | Токен Telegram бота от BotFather. |
| `TELEGRAM_ADMIN_IDS` | `''` | Telegram user id администраторов. |
| `TELEGRAM_BOT_POLL_TIMEOUT_SECONDS` | `25` | Timeout long polling для `getUpdates`. |
| Subscription реквизиты | `''` | Телефон, имя получателя, банк, комментарий. |

Notes:

- Эти параметры уже редактируются через `Settings`.
- Env-значения используются как fallback/bootstrap only.

### Local traffic history

| Setting | Default | Description |
|---|---|---|
| `TRAFFIC_HISTORY_ENABLED` | `false` | Включить локальное хранение трафика и скоростей. |
| `TRAFFIC_SAMPLE_INTERVAL_SECONDS` | `1` | Интервал сэмплирования. |
| `TRAFFIC_RAW_RETENTION_HOURS` | `24` | Сколько хранить сырые 1-секундные данные. |
| `TRAFFIC_MINUTE_RETENTION_DAYS` | `90` | Сколько хранить минутные агрегаты. |
| `TRAFFIC_HOUR_RETENTION_DAYS` | `365` | Сколько хранить часовые агрегаты. |

Notes:

- Данные сохраняются в `${WG_PATH}/traffic-history`.
- Для периода `day` используются raw 1s samples, для `week` минутные агрегаты, для `month` часовые агрегаты.
- API:
  - `GET /api/wireguard/traffic`
  - `GET /api/wireguard/client/:clientId/traffic?period=day|week|month`
- `/metrics/json` дополнительно возвращает список `clients` с текущими `rx_bytes_per_second` / `tx_bytes_per_second`, если sampler успел собрать данные.

## Practical rule

Если параметр влияет на:

- то, как контейнер стартует,
- какие пути/сертификаты/порты bind использует сам процесс,
- или как приложение интегрируется с host networking,

оставляйте его в `.env`.

Если параметр влияет на:

- WireGuard runtime defaults,
- поведение UI,
- Telegram,
- трафик/историю,
- выдачу конфигов,
- логику продукта,

держите его в web setup/settings.
