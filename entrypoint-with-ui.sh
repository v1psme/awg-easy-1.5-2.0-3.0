#!/bin/sh
set -e

echo "=== AmneziaWG (version ${AMNEZIA_VERSION:-1.5}) + Web UI ==="

# I1-I5 (CPS) больше НЕ генерируются в entrypoint: генерация — в src/lib/mimicry.js
# (config.js + миграция WireGuard.js при старте). Node перезаписывает awg0.conf
# при каждом старте, а серверный conf без I-строк валиден (I — декои, опциональны).
# Здесь — только passthrough явно заданных в env значений.

# Определяем исходящий интерфейс
OUTBOUND_IFACE="${WAN_INTERFACE:-$(ip route | grep default | head -1 | awk '{print $5}')}"
echo "Using interface: $OUTBOUND_IFACE"

# Переменные окружения с дефолтами
WG_PORT="${WG_PORT:-51820}"
PORT="${PORT:-51821}"
WG_HOST="${WG_HOST}"
PASSWORD_HASH="${PASSWORD_HASH}"
WG_DEFAULT_ADDRESS="${WG_DEFAULT_ADDRESS:-10.8.0.x}"
WG_MTU="${WG_MTU:-1420}"
AMNEZIA_VERSION="${AMNEZIA_VERSION:-1.5}"

# Параметры AWG 1.5 (mobile preset: Jc=3, narrow Jmin/Jmax)
JC="${JC:-3}"
JMIN="${JMIN:-40}"
JMAX="${JMAX:-80}"
S1="${S1:-64}"
S2="${S2:-120}"
# Ensure S1+56 != S2
if [ $((S1 + 56)) -eq $S2 ]; then S2=$((S1 + 57)); fi
H1="${H1:-1634716843}"
H2="${H2:-1948862386}"
H3="${H3:-1386309140}"
H4="${H4:-128735623}"

# Параметры AWG 2.0 (narrower ranges per spec: S3=8-55, S4=4-27)
S3="${S3:-30}"
S4="${S4:-12}"

# Создаём конфиг, если его нет
CONFIG_PATH="/etc/amnezia/amneziawg/awg0.conf"
if [ ! -f "$CONFIG_PATH" ]; then
    echo "Creating config at $CONFIG_PATH"
    mkdir -p /etc/amnezia/amneziawg
    PRIVKEY=$(awg genkey)
    
    # Основной блок
    cat > "$CONFIG_PATH" <<EOF
[Interface]
Address = ${WG_DEFAULT_ADDRESS/\.x/.1}/24
ListenPort = $WG_PORT
PrivateKey = $PRIVKEY
MTU = $WG_MTU
PostUp = iptables -t nat -A POSTROUTING -s ${WG_DEFAULT_ADDRESS/\.x/.0}/24 -o $OUTBOUND_IFACE -j MASQUERADE; iptables -A FORWARD -i awg0 -j ACCEPT; iptables -A FORWARD -o awg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -s ${WG_DEFAULT_ADDRESS/\.x/.0}/24 -o $OUTBOUND_IFACE -j MASQUERADE; iptables -D FORWARD -i awg0 -j ACCEPT; iptables -D FORWARD -o awg0 -j ACCEPT

# AWG 1.5 parameters
Jc = $JC
Jmin = $JMIN
Jmax = $JMAX
S1 = $S1
S2 = $S2
H1 = $H1
H2 = $H2
H3 = $H3
H4 = $H4
EOF

    if [ "$AMNEZIA_VERSION" = "2" ] || [ "$AMNEZIA_VERSION" = "2.0" ] || [ "$AMNEZIA_VERSION" = "3" ] || [ "$AMNEZIA_VERSION" = "3.0" ]; then
        cat >> "$CONFIG_PATH" <<EOF

# AWG 2.0 parameters
S3 = $S3
S4 = $S4
EOF
        for i in 1 2 3 4 5; do
            eval "val=\$$(echo I$i)"
            if [ -n "$val" ] && [ "$val" != "0" ] && [ "$val" != "null" ]; then
                echo "I$i = $val" >> "$CONFIG_PATH"
            fi
        done

    fi
fi


echo "Starting AmneziaWG on port $WG_PORT..."
awg-quick up awg0

echo "Starting Web UI on port $PORT..."
cd /app
exec node server.js
