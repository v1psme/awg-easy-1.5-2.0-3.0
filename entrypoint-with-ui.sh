#!/bin/sh
set -e

echo "=== AmneziaWG (version ${AMNEZIA_VERSION:-1.5}) + Web UI ==="

# Генерация I1 — DNS-mimic формат
generate_dns_mimic() {
    local txid=$(openssl rand -hex 2)
    local r_min="${I_R_MIN:-2}"
    local r_max="${I_R_MAX:-40}"
    local r_len=$(( r_min + (RANDOM % (r_max - r_min + 1)) ))
    echo "<r ${r_len}><b 0x${txid}00010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>"
}

# Генерация I2-I5 — <b 0xHEX><r N> (без rc)
generate_cps() {
    local b_hex=$(openssl rand -hex 16)
    local r_min="${I_R_MIN:-2}"
    local r_max="${I_R_MAX:-40}"
    local r_len=$(( r_min + (RANDOM % (r_max - r_min + 1)) ))
    echo "<b 0x${b_hex}><r ${r_len}>"
}

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

# Генерация I1-I5 (CPS) — только для версий 2+
if [ "$AMNEZIA_VERSION" = "2" ] || [ "$AMNEZIA_VERSION" = "2.0" ] || [ "$AMNEZIA_VERSION" = "3" ] || [ "$AMNEZIA_VERSION" = "3.0" ]; then
for i in 1 2 3 4 5; do
    var_name="I$i"
    eval "current=\$$var_name"
    # Only generate if var is NOT set in env. Empty string = user disabled it.
    eval "is_set=\${${var_name}+x}"
    if [ "$is_set" != "x" ] || [ "$current" = "0" ]; then
        if [ $i -eq 1 ] || [ "${I_DNS_MIMIC_ALL:-false}" = "true" ]; then
            new_val=$(generate_dns_mimic)
        else
            new_val=$(generate_cps)
        fi
        eval "$var_name=\"\$new_val\""
        export "$var_name"
    fi
done
fi

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
            if [ -n "$val" ] && [ "$val" != "0" ]; then
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
