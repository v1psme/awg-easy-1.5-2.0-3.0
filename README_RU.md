# RedNetAmnezia

Самый простой способ запустить **WireGuard VPN + обфускацию AmneziaWG** с веб-интерфейсом администрирования, Telegram ботом и маршрутизацией на основе политик.

Форк [wg-easy](https://github.com/wg-easy/wg-easy) с добавленной поддержкой **AmneziaWG** — обфусцированного протокола WireGuard, который помогает обходить DPI (Deep Packet Inspection) путём добавления мусорных пакетов, рандомизации заголовков и продвинутых техник маскировки трафика.

> [!WARNING]
> **AmneziaWG требует специальный клиент.** Стандартные WireGuard клиенты, такие как официальное приложение WireGuard, WireGuard Go, tun2socks или Tunsafe, **НЕ** будут работать, так как используют стандартное рукопожатие. Необходимо использовать [AmneziaVPN клиент](https://amnezia.org) или [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go).

> [!NOTE]
> **Версия AWG** управляется переменной `AMNEZIA_VERSION`: `1.5` (базовая обфускация), `2` (добавляет CPS I1–I5 + DNS-mimic) или `3` (добавляет таймеры, ContentPadding, HeaderProtectionKey — экспериментально). Устаревшая переменная `AMNEZIAWG_ENABLED=true` всё ещё принимается (эквивалент v2), но её использование не рекомендуется.

---

## Возможности

### VPN и Протокол
- **AWG 1.5** — параметры Jc, Jmin, Jmax, S1, S2, H1–H4
- **AWG 2.0** — добавляет S3, S4, I1–I5 CPS (сигнатуры инициирующих пакетов), I1 авто-генерируется как DNS-mimic
- **AWG 3.0** — добавляет таймеры (RekeyAfterTime/RekeyTimeout/RejectAfterTime/KeepaliveTimeout/MaxHandshakeAttempts), ContentPaddingAddition, HeaderProtectionKey (экспериментально, выключено по умолчанию)
- Авто-генерация непересекающихся диапазонов H1–H4 (равномерно по пространству uint32 для v2+)
- Авто S1/S2 с ограничением `S1+56 ≠ S2` (требование документации Amnezia)
- Режим userspace через `amneziawg-go` — модуль ядра не требуется
- Автоматические правила iptables NAT и форвардинга

### Веб-интерфейс
- Vue.js SPA с адаптивным дизайном (для мобильных устройств)
- Панель со списком клиентов и графиками трафика (ApexCharts)
- Генерация QR-кодов для конфигураций клиентов
- Скачивание / копирование конфигураций / одноразовые ссылки (`/cnf/:link`)
- **Экспорт `.vpn` файла для AmneziaVPN** + копирование ключа `vpn://`
- Создание, включение/отключение, удаление клиентов
- Для каждого клиента: имя, адрес, email, Telegram ID, группы, срок действия, назначенный аплинк
- Статистика трафика по клиентам (скачивание/загрузка)
- История трафика с агрегацией: сырые данные (1с) / поминутно / почасово
- Срок действия клиентов
- Тёмная / Светлая / Авто тема
- Мультиязычность: английский, русский

### Сеть и Маршрутизация
- **Аплинк-туннели** — несколько исходящих WireGuard туннелей с маршрутизацией на основе политик (источник + домен + CIDR)
- **Назначение аплинка клиенту** — маршрутизация конкретных клиентов через конкретные туннели
- **Интеграция с GeoSite** — авто-загрузка списков доменов из [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community), рекурсивное разрешение `include:`, кеширование локально, еженедельная авто-синхронизация (cron)
- **GeoIP / CIDR маршрутизация** — маршрутизация по IP через `ipset` с массовой загрузкой `ipset restore` (ёмкость 88K+ CIDR, `maxelem 131072`)
- **Защищённые CIDR** — сети сервера/локальные сети, которые никогда не должны уходить через туннель
- **DNS маршрутизация** через встроенный `dnsmasq` — прозрачный DNS прокси (iptables REDIRECT порт 53), заполняет ipset для доменной маршрутизации
- **DNS Pre-resolve** — предварительный резолв всех доменов в IP, кеширование в JSON файл, мгновенное заполнение ipset при перезапуске контейнера без DNS запросов
- **Изоляция клиентов (ACL)** — межклиентский файрвол на iptables с поддержкой групп
- **Категории маршрутизации** — наборы доменов, задаваемые администратором, с переключением для каждого клиента
- **Bypass** — маршрутизация определённых IP/доменов в обход VPN туннеля (например, локальные ресурсы страны)

### Безопасность и Мониторинг
- Защита веб-интерфейса паролем (обычный текст или bcrypt хеш)
- **Аутентификация по логину и паролю** (переменная `ADMIN_LOGIN`)
- **Настраиваемый URL-префикс** (переменная `WEB_PATH`) — скрытие панели за случайным путём
- HTTPS/SSL с пользовательскими сертификатами
- Управление сессиями с настраиваемым временем жизни (`MAX_AGE`)
- Prometheus метрики (`/metrics`, `/metrics/json`) с опциональной Basic Auth

### Telegram Бот
- Long-polling бот для управления клиентами
- Доступ по подписке (200 ₽/30 дней)
- Отслеживание платежей с реквизитами банковского перевода
- Напоминания об окончании льготного периода
- Доставка QR-кодов через Telegram

### DevOps
- Многоэтапная сборка Docker (Node.js 18 + amneziawg-go базовый образ)
- Docker Compose для production развёртывания
- SQLite для хранения всех настроек и состояния
- **Поддержка нескольких экземпляров** через `CONTAINER_SUFFIX`
- Резервное копирование / Восстановление конфигурации

---

## Быстрый Старт

### 1. Подготовка окружения

```bash
# Скопируйте пример env файла
cp .env_example .env

# Отредактируйте .env — укажите внешний IP и пароли
nano .env
```

Минимальная конфигурация `.env`:

```env
WG_HOST=your-server-ip-or-domain
PORT=51821
PASSWORD_HASH='your-bcrypt-hash'
WG_PORT=51820
WG_DEFAULT_ADDRESS=10.28.0.x
AMNEZIA_VERSION=2
```

### 2. Генерация хеша пароля (рекомендуется)

```bash
# Локально с Node.js (в директории src/):
node src/wgpw.mjs YOUR_PASSWORD

# Или через Docker:
docker run --rm -it rednetamnezia:latest node wgpw.mjs YOUR_PASSWORD
```

Скопируйте значение `PASSWORD_HASH` в ваш `.env`. Подробнее в [How_to_generate_an_bcrypt_hash.md](./How_to_generate_an_bcrypt_hash.md).

### 3. Запуск контейнера

```bash
docker compose up -d
```

### 4. Доступ к веб-интерфейсу

Откройте `http://your-server-ip:51821` в браузере. При первом запуске отобразится **экран первичной настройки**, где можно задать пароль администратора, хост сервера (WG_HOST) и DNS по умолчанию.

Если установлен `WEB_PATH=mysecretpath`, интерфейс будет доступен по адресу `http://your-server-ip:51821/mysecretpath/`.

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

> **Примечание:** Блок `build:` можно опустить при использовании готового образа. `build.args.AMNEZIA_VERSION` нужен только при локальной сборке — он определяет, какие AWG патчи применяются на этапе сборки.

---

## Переменные Окружения

Переменные делятся на **bootstrap** (должны быть в `.env` — влияют на запуск контейнера, порты, пути, сеть) и **web-управляемые** (настраиваются через Веб-интерфейс → Настройки, хранятся в SQLite). Полный справочник см. в [ENV_VARIABLES.md](./ENV_VARIABLES.md).

### 0. Настройки Контейнера

| Переменная | По умолчанию | Описание |
|---|---|---|
| `CONTAINER_SUFFIX` | — | Суффикс для запуска нескольких экземпляров (влияет на имя контейнера + имя сети) |

### 1. Bootstrap — Обязательные

| Переменная | По умолчанию | Описание |
|---|---|---|
| `WG_HOST` | — | Публичный IP или домен сервера |
| `PORT` | `51821` | TCP порт для веб-интерфейса |
| `WEBUI_HOST` | `0.0.0.0` | Адрес привязки веб-сервера |
| `PASSWORD` | — | Пароль администратора (обычный текст) |
| `PASSWORD_HASH` | — | Пароль администратора (bcrypt хеш, **рекомендуется**) |
| `ADMIN_LOGIN` | — | Имя пользователя для входа (пусто = только пароль) |
| `WEB_PATH` | — | URL-префикс для веб-интерфейса (напр. `mypanel` → `/mypanel/`) |
| `REDIRECT_ROOT` | `true` | Перенаправлять `/` на `/<WEB_PATH>/` (установите `false` для отключения) |
| `SERVICE_NAME` | `RenNetline` | Название сервиса в заголовке интерфейса |
| `WG_PORT` | `51820` | UDP порт для WireGuard |
| `WG_CONFIG_PORT` | (WG_PORT) | Порт в клиентских конфигах (переопределите, если Docker маппинг портов отличается) |
| `WG_MTU` | `1280` | MTU для клиентов |
| `WG_DEFAULT_ADDRESS` | `10.8.0.x` | Подсеть клиентских IP (напр. `10.28.0.x`) |
| `WG_DEFAULT_DNS` | `1.1.1.1` | DNS сервер для клиентов |
| `WG_ALLOWED_IPS` | `0.0.0.0/0, ::/0` | AllowedIPs в клиентских конфигах |
| `WG_PERSISTENT_KEEPALIVE` | `25` | PersistentKeepalive в клиентских конфигах |
| `WG_DEVICE` | `eth0` | Исходящий сетевой интерфейс |
| `WG_PATH` | `/etc/amnezia/amneziawg/` | Директория конфигурации, БД и состояния |
| `AMNEZIA_VERSION` | `1.5` | Версия протокола AWG: `1.5`, `2` или `3` |
| `LANG` | `en` | Язык интерфейса (`en`, `ru`) |
| `MAX_AGE` | `0` | Время жизни сессии в минутах (0 = сессионная cookie) |

### 2. HTTPS / SSL

| Переменная | По умолчанию | Описание |
|---|---|---|
| `SSL_ENABLED` | `false` | Включить HTTPS |
| `SSL_CERT_PATH` | `/etc/ssl/certs/ssl-cert.pem` | Путь к SSL сертификату |
| `SSL_KEY_PATH` | `/etc/ssl/private/ssl-key.pem` | Путь к приватному ключу SSL |

### 3. Хуки WireGuard и Сеть

| Переменная | Описание |
|---|---|
| `WG_PRE_UP` | Команда перед запуском WG |
| `WG_POST_UP` | Команда после запуска WG (по умолчанию: встроенные правила iptables NAT + forwarding) |
| `WG_PRE_DOWN` | Команда перед остановкой WG |
| `WG_POST_DOWN` | Команда после остановки WG (по умолчанию: очистка iptables) |
| `WG_UPLINK_CONFIGS_PATH` | Директория для `.conf` файлов аплинков (по умолчанию: `/etc/wireguard/uplinks`) |

### 4. Prometheus Метрики

| Переменная | По умолчанию | Описание |
|---|---|---|
| `ENABLE_PROMETHEUS_METRICS` | `false` | Включить эндпоинты `/metrics` и `/metrics/json` |
| `PROMETHEUS_METRICS_PASSWORD` | — | Пароль Basic Auth для метрик (обычный текст) |
| `PROMETHEUS_METRICS_PASSWORD_HASH` | — | Пароль Basic Auth для метрик (bcrypt хеш) |

### 5. Параметры Обфускации AmneziaWG

Все параметры обфускации генерируются автоматически, если не заданы. Переопределяйте только при необходимости фиксированных значений.

| Переменная | Тип | Описание |
|---|---|---|
| `JC` | int | Количество мусорных пакетов (по умолчанию: 3) |
| `JMIN` | int | Мин. размер мусорного пакета (авто: 35–50) |
| `JMAX` | int | Макс. размер мусорного пакета (авто: JMIN+20..60) |
| `S1` | int | Размер мусора инициирующего пакета (авто: 15–150, ограничение: S1+56 ≠ S2) |
| `S2` | int | Размер мусора ответного пакета |
| `S3` | int | AWG 2.0+填充 cookie ответа (авто: 8–55; v3 мин. 12) |
| `S4` | int | AWG 2.0+填充 данных (авто: 4–27; v3 мин. 12) |
| `H1` | string | Magic header инициирующего пакета (авто: непересекающийся диапазон для v2+, одиночное значение для v1.5) |
| `H2` | string | Magic header ответного пакета |
| `H3` | string | Magic header underload пакета |
| `H4` | string | Magic header транспортного пакета |
| `I1` | string | AWG 2.0+ сигнатура инициирующего пакета (авто: DNS-mimic) |
| `I2`–`I5` | string | AWG 2.0+ дополнительные CPS (авто: `<b 0xHEX><r N>`; пусто = отключено) |
| `I_R_MIN` | int | Мин. значение `<r>` для I1–I5 (по умолчанию: 2) |
| `I_R_MAX` | int | Макс. значение `<r>` для I1–I5 (по умолчанию: 40 — см. Известные Проблемы) |
| `I1_DNS_SITES` | string | Список доменов через запятую для I1 DNS-mimic (по умолчанию: `icloud.com,google.com,nvidia.com`) |
| `I1_DNS_NSLOOKUP` | bool | Использовать реальный DNS резолв для I1 доменов |
| `I_DNS_MIMIC_ALL` | bool | Генерировать I2–I5 также как DNS-mimic (по умолчанию `false`) |

### 6. Параметры AWG 3.0

Активны только при `AMNEZIA_VERSION=3`. Значения — диапазоны (`lo-hi`) или `(off)` для отключения.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `HEADER_PROTECTION_KEY_ENABLE` | `false` | Включить защиту заголовков (экспериментально, см. Известные Проблемы) |
| `HEADER_PROTECTION_KEY` | авто | 44-символьный base64 ключ (авто-генерируется если включено) |
| `CONTENT_PADDING_ADDITION` | `16-128` | Диапазон дополнения содержимого, или `(off)` |
| `REKEY_AFTER_TIME` | `100-145` | Диапазон времени до пересоздания ключа, или `(off)` |
| `REKEY_TIMEOUT` | `4-10` | Диапазон таймаута пересоздания ключа, или `(off)` |
| `REJECT_AFTER_TIME` | `180-200` | Диапазон времени до отбрасывания, или `(off)` |
| `KEEPALIVE_TIMEOUT` | `8-22` | Диапазон таймаута keepalive, или `(off)` |
| `MAX_HANDSHAKE_ATTEMPTS` | `12-28` | Диапазон макс. попыток рукопожатия, или `(off)` |

### 7. История Трафика

| Переменная | По умолчанию | Описание |
|---|---|---|
| `TRAFFIC_HISTORY_ENABLED` | `false` | Включить сбор истории трафика |
| `TRAFFIC_SAMPLE_INTERVAL_SECONDS` | `1` | Интервал сбора |
| `TRAFFIC_RAW_RETENTION_HOURS` | `24` | Хранение сырых (1-секундных) данных |
| `TRAFFIC_MINUTE_RETENTION_DAYS` | `90` | Хранение поминутно агрегированных данных |
| `TRAFFIC_HOUR_RETENTION_DAYS` | `365` | Хранение почасово агрегированных данных |

### 8. Telegram Бот

| Переменная | По умолчанию | Описание |
|---|---|---|
| `TELEGRAM_BOT_ENABLED` | `false` | Включить Telegram бота |
| `TELEGRAM_BOT_TOKEN` | — | Токен бота от BotFather |
| `TELEGRAM_ADMIN_IDS` | — | ID администраторов Telegram через запятую |
| `TELEGRAM_BOT_POLL_TIMEOUT_SECONDS` | `25` | Таймаут long polling |

### Устаревшие Переменные

| Устаревшая | Замена |
|---|---|
| `AMNEZIAWG_ENABLED=true` | `AMNEZIA_VERSION=2` |
| `PROMETHEUS_METRICS_PASSWORD_PLAIN` | `PROMETHEUS_METRICS_PASSWORD` |
| `PROMETHEUS_METRICS_PASSWORD_BCRYPT` | `PROMETHEUS_METRICS_PASSWORD_HASH` |

> Большинство настроек также можно изменить через **Веб-интерфейс → Настройки** после первичной настройки. Параметры обфускации AWG, хуки WG и сетевые bootstrap переменные должны оставаться в `.env`.

---

## Справочник по Обфускации AmneziaWG

### Поддерживаемые Параметры (согласно Документации Amnezia)

| Параметр | Диапазон | Описание |
|---|---|---|
| **Jc** | 0–10 | Количество мусорных пакетов |
| **Jmin / Jmax** | 64–1024 | Границы размера мусорных пакетов |
| **S1** | 0–64 | Дополнение инициирующего пакета |
| **S2** | 0–64 | Дополнение ответного пакета |
| **S3** | 0–64 | Дополнение Cookie Reply (v2+) |
| **S4** | 0–32 | Дополнение данных (v2+) |
| **H1–H4** | 0–4,294,967,295 | Динамические заголовки (v2+: непересекающиеся диапазоны; v1.5: одиночные значения) |

### CPS Теги (I1–I5, v2+)

| Тег | Формат | Лимит | Описание |
|---|---|---|---|
| `<b>` | `<b 0xHEX>` | произвольно | Произвольные байты |
| `<r>` | `<r N>` | ≤ 1000 | Случайные байты |
| `<rc>` | `<rc N>` | ≤ 1000 | Случайные байты + CRC |
| `<rd>` | `<rd N>` | ≤ 1000 | Случайные байты + дубликат заголовка |
| `<t>` | — | — | **НЕ ИСПОЛЬЗОВАТЬ** — вызывает несовпадение рукопожатия |

- **I1** (по умолчанию): DNS-mimic — `<r N><b 0xTXID+DNS_PAYLOAD>` со случайным доменом из `I1_DNS_SITES`
- **I2–I5** (по умолчанию): `<b 0xHEX><r N>` — независимые случайные длины; пустое значение отключает каждый
- **I_DNS_MIMIC_ALL=true**: I2–I5 также используют формат DNS-mimic

### Замечания по Авто-Генерации

- **H1–H4** для v2+ равномерно распределяются по пространству uint32 как непересекающиеся диапазоны с зазорами (используется `generateSpreadRanges`)
- Ограничение **S1 + 56 ≠ S2** соблюдается согласно документации Amnezia
- **Лимит `<r>`**: эмпирически, значения выше **40** ломают рукопожатие (по состоянию на 10.08.2026). По умолчанию: `I_R_MIN=2`, `I_R_MAX=40`
- **Тег `<t>`** никогда не должен использоваться — он внедряет временные метки в каждый пакет, что вызывает несовпадение рукопожатия

---

## API Эндпоинты

### Системные / Информация
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/release` | Версия приложения |
| `GET` | `/api/service-info` | Название сервиса + версия AWG |
| `GET` | `/api/lang` | Текущий язык интерфейса |
| `GET` | `/api/events` | SSE поток для живых обновлений UI |

### Сессии и Аутентификация
| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/session` | Вход |
| `GET` | `/api/session` | Проверка статуса сессии |
| `DELETE` | `/api/session` | Выход |

### Первичная Настройка
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/setup-state` | Статус настройки + значения по умолчанию |
| `POST` | `/api/setup` | Сохранить начальную конфигурацию |

### Настройки
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/settings` | Получить все настройки |
| `PUT` | `/api/settings` | Обновить настройки |

### Клиенты WireGuard
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/wireguard/client` | Список всех клиентов |
| `POST` | `/api/wireguard/client` | Создать клиента |
| `DELETE` | `/api/wireguard/client/:clientId` | Удалить клиента |
| `POST` | `/api/wireguard/client/:clientId/enable` | Включить клиента |
| `POST` | `/api/wireguard/client/:clientId/disable` | Отключить клиента |
| `POST` | `/api/wireguard/client/:clientId/generateOneTimeLink` | Создать одноразовую ссылку |
| `PUT` | `/api/wireguard/client/:clientId/name` | Обновить имя клиента |
| `PUT` | `/api/wireguard/client/:clientId/address` | Обновить адрес клиента |
| `PUT` | `/api/wireguard/client/:clientId/email` | Обновить email клиента |
| `PUT` | `/api/wireguard/client/:clientId/expireDate` | Обновить срок действия |
| `PUT` | `/api/wireguard/client/:clientId/telegram-id` | Обновить Telegram ID |
| `PUT` | `/api/wireguard/client/:clientId/groups` | Обновить группы клиента |
| `PUT` | `/api/wireguard/client/:clientId/acl-groups` | Обновить ACL группы |
| `GET` | `/api/wireguard/client/:clientId/configuration` | Скачать `.conf` файл |
| `GET` | `/api/wireguard/client/:clientId/vpn-config` | Скачать `.vpn` файл (AmneziaVPN) |
| `GET` | `/api/wireguard/client/:clientId/vpn-key` | Получить `vpn://` ключ |
| `GET` | `/api/wireguard/client/:clientId/qrcode.svg` | QR-код (SVG) |
| `GET` | `/api/wireguard/client/:clientId/traffic` | История трафика клиента |
| `POST` | `/api/wireguard/client-uplink-assignment` | Назначить клиенту аплинк |

### Трафик
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/wireguard/traffic` | Общая статистика трафика |

### Изоляция Клиентов (ACL)
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/wireguard/client-isolation` | Получить правила изоляции |
| `PUT` | `/api/wireguard/client-isolation` | Обновить правила изоляции |

### Аплинки
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/wireguard/uplinks` | Список всех аплинков |
| `PUT` | `/api/wireguard/uplinks` | Сохранить настройки аплинков |
| `GET` | `/api/wireguard/uplink` | Получить один аплинк |
| `PUT` | `/api/wireguard/uplink` | Обновить один аплинк |
| `GET` | `/api/wireguard/uplink-configs` | Список доступных конфигурационных файлов |
| `POST` | `/api/wireguard/uplink-configs` | Загрузить конфигурационный файл |
| `GET` | `/api/wireguard/uplink-protected-cidrs` | Получить защищённые CIDR |
| `PUT` | `/api/wireguard/uplink-protected-cidrs` | Обновить защищённые CIDR |
| `POST` | `/api/wireguard/uplink/test` | Проверить соединение аплинка |
| `POST` | `/api/wireguard/uplink/:uplinkId/test` | Проверить конкретный аплинк |
| `GET` | `/api/wireguard/uplink/geosite-status` | Статус данных GeoSite |
| `POST` | `/api/wireguard/uplink/geosite-load` | Загрузить домены GeoSite |
| `POST` | `/api/wireguard/uplink/geoip-load` | Загрузить CIDR GeoIP |
| `POST` | `/api/wireguard/uplink-domains-file` | Загрузить файл доменов для аплинка |

### Категории Маршрутизации
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/wireguard/routing-categories` | Список категорий |
| `PUT` | `/api/wireguard/routing-categories` | Обновить категории |
| `GET` | `/api/wireguard/client/:clientId/routing-categories` | Категории клиента |
| `PUT` | `/api/wireguard/client/:clientId/routing-categories/:categoryId` | Переключить категорию клиенту |

### DNS Маршрутизация
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/wireguard/dns-routing` | Настройки DNS маршрутизации |
| `PUT` | `/api/wireguard/dns-routing` | Обновить DNS маршрутизацию |
| `GET` | `/api/wireguard/dns-routing/resolve-status` | Прогресс pre-resolve + ETA |
| `POST` | `/api/wireguard/dns-routing/resolve` | Запустить pre-resolve |
| `GET` | `/api/wireguard/dns-logs` | Хвост лога запросов dnsmasq |

### Резервное Копирование
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/wireguard/backup` | Скачать резервную копию |
| `PUT` | `/api/wireguard/restore` | Восстановить из резервной копии |

### Prometheus
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/metrics` | Prometheus текстовый формат |
| `GET` | `/metrics/json` | JSON формат с метриками по клиентам |

### Одноразовая Конфигурация
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/cnf/:clientOneTimeLink` | Скачать конфиг клиента (без аутентификации, одноразово, 5 мин) |

---

## Известные Проблемы и Ограничения

| Проблема | Статус | Описание |
|---|---|---|
| **HeaderProtectionKey (v3)** | ❌ Не работает | Не совместим с текущим клиентом AmneziaVPN. `HEADER_PROTECTION_KEY_ENABLE` по умолчанию `false` |
| **Стабильность I2–I5** | ⚠️ Отключены | Периодически ломают рукопожатие с некоторыми сборками клиента. По умолчанию отключены (пустые в `.env`); используйте только I1 при проблемах |
| **Лимит `<r>`** | ⚠️ Задокументировано | Значения выше **40** ломают рукопожатие (эмпирически, на 10.08.2026). Контролируется `I_R_MIN=2`, `I_R_MAX=40` |
| **CPS тег `<t>`** | ❌ Запрещён | Никогда не использовать — внедряет временные метки в пакеты, вызывая несовпадение рукопожатия |
| **Ручной iptables** | ⚠️ Требуется | Межсерверные аплинк-туннели требуют ручных правил FORWARD + MASQUERADE после перезапуска контейнера (или используйте хуки `WG_PRE_UP`/`WG_POST_UP`) |
| **v3 .vpn экспорт** | ⚠️ Протокол v2 | Экспорт `.vpn` использует версию протокола 2 (AmneziaVPN разбирает только v2). Параметры v3 включены, но совместимость с клиентом ограничена |

---

## Структура Проекта

```
├── Dockerfile                  # Многоэтапная сборка (Node.js + amneziawg-go)
├── docker-compose.yml          # Production развёртывание
├── entrypoint-with-ui.sh       # Точка входа контейнера (настройка AWG + Node.js)
├── wireguard-patch.sh          # Скрипт патчинга AWG 2.0/3.0 (на этапе сборки)
├── .env_example                # Шаблон переменных окружения
├── ENV_VARIABLES.md            # Полный справочник переменных окружения
├── How_to_generate_an_bcrypt_hash.md
│
├── src/
│   ├── server.js               # Точка входа приложения
│   ├── config.js               # Конфигурация окружения + генерация AWG параметров
│   ├── wgpw.mjs / wgpw.sh      # Утилиты генерации bcrypt хеша
│   ├── services/
│   │   ├── Server.js           # HTTP/HTTPS сервер (фреймворк h3)
│   │   ├── WireGuard.js        # Сервис управления WireGuard
│   │   └── TelegramBot.js      # Сервис Telegram бота
│   ├── lib/
│   │   ├── Server.js           # Реализация сервера (API маршруты, аутентификация, настройка)
│   │   ├── WireGuard.js        # Генератор конфигураций WG, управление клиентами, аплинки, DNS
│   │   ├── TelegramBot.js      # Логика бота (polling, платежи, подписки)
│   │   ├── ConfigStore.js      # SQLite хранилище конфигурации
│   │   ├── TelegramStore.js    # SQLite хранилище Telegram состояния
│   │   ├── TrafficHistory.js   # Сбор и агрегация данных трафика
│   │   ├── Util.js             # Вспомогательные функции
│   │   ├── ServerError.js      # Обработка ошибок
│   │   └── db/
│   │       ├── SqliteMigrator.js
│   │       └── migrations/     # SQLite миграции схемы
│   └── www/                    # Веб-интерфейс (Vue.js SPA)
│       ├── index.html          # Главная страница SPA
│       ├── login.html          # Страница входа
│       ├── manifest.json       # PWA манифест
│       ├── js/
│       │   ├── app.js          # Vue.js приложение (~2700 строк)
│       │   ├── api.js          # API клиент
│       │   ├── i18n.js         # Интернационализация (EN + RU)
│       │   └── vendor/         # Сторонние библиотеки
│       ├── css/                # Скомпилированный CSS
│       └── img/                # Иконки, логотипы
│
├── bypass/                     # Файлы данных GeoIP / GeoSite
│   ├── geoip/
│   └── geosite/
├── uplinks/                    # Конфигурации аплинк-туннелей
├── data/                       # Рантайм состояние (примонтированный том)
├── backups/                    # Резервные копии конфигурации
└── cert/                       # SSL сертификаты (примонтированный том)
```

---

## Сборка и Разработка

### Сборка Docker образа

```bash
docker build -t rednetamnezia .
# или с указанием версии:
docker build --build-arg AMNEZIA_VERSION=3 -t rednetamnezia .
```

### Локальная разработка (без Docker)

```bash
cd src
npm ci
npm run serve              # с nodemon (горячая перезагрузка)
npm run serve-with-password  # с PASSWORD=wg
```

### Запуск тестов

```bash
cd src
npm test
```

### Пересборка CSS

```bash
cd src
npm run buildcss           # перекомпиляция Tailwind CSS
```

---

## Клиенты

Для подключения необходим **AmneziaWG-совместимый клиент**:

| Платформа | Клиент |
|---|---|
| Windows / macOS / Linux | [AmneziaVPN](https://amnezia.org) |
| Linux CLI | [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) |
| Android | [AmneziaVPN для Android](https://play.google.com/store/apps/details?id=org.amnezia.vpn) |
| iOS | [AmneziaVPN для iOS](https://apps.apple.com/app/amnezia-vpn/id1600529900) |

Стандартные WireGuard клиенты (официальное приложение WireGuard, WireGuard Go, TunSafe и др.) **не совместимы** из-за кастомного обфусцированного рукопожатия.

---

## Лицензия

Проект распространяется под лицензией [CC BY-NC-SA 4.0](./LICENSE) — Attribution-NonCommercial-ShareAlike 4.0 International.

Оригинальный [wg-easy](https://github.com/wg-easy/wg-easy) от Emile Nijssen.
