# Stage 1: Node.js модули
FROM node:24-alpine AS build_node
RUN npm install -g npm@11
COPY src /app
WORKDIR /app
RUN npm ci --omit=dev && mv node_modules /node_modules

# Stage 2: финальный образ с amneziawg-go
FROM amneziavpn/amneziawg-go:latest

# Системные пакеты + libstdc++ (нужна для Node 24)
RUN apk add --no-cache \
    dumb-init libstdc++ iptables iproute2 openssl dnsmasq sqlite ipset git bash

# Копируем Node 24 из build-стадии (вместо apk add nodejs)
COPY --from=build_node /usr/local/bin/node /usr/local/bin/node
COPY --from=build_node /usr/local/lib/node_modules /usr/local/lib/node_modules

# Копируем модули и веб-интерфейс
COPY --from=build_node /app /app
COPY --from=build_node /node_modules /node_modules
COPY bypass /app/bypass

# Патчим для AWG 2.0/3.0
ARG AMNEZIA_VERSION=1.5
ENV AMNEZIA_VERSION=$AMNEZIA_VERSION
COPY wireguard-patch.sh /tmp/patch.sh
RUN chmod +x /tmp/patch.sh && WG_CONFIG_NAME=awg0 /tmp/patch.sh && rm /tmp/patch.sh

COPY entrypoint-with-ui.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && sed -i 's/\r$//' /entrypoint.sh

WORKDIR /app
CMD ["/usr/bin/dumb-init", "/entrypoint.sh"]
