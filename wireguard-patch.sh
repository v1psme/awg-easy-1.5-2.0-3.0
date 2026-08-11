#!/bin/sh
set -e

AWG_VERSION="${AMNEZIA_VERSION:-1.5}"

cd /app/lib

WG_NAME="${WG_CONFIG_NAME:-wg0}"
if [ "$WG_NAME" != "wg0" ]; then
  echo "Changing interface from wg0 to $WG_NAME..."
  sed -i "s/wg0/$WG_NAME/g" WireGuard.js
fi

is_awg2_plus() {
  [ "$AWG_VERSION" = "2" ] || [ "$AWG_VERSION" = "2.0" ] || \
  [ "$AWG_VERSION" = "3" ] || [ "$AWG_VERSION" = "3.0" ]
}

is_awg3() {
  [ "$AWG_VERSION" = "3" ] || [ "$AWG_VERSION" = "3.0" ]
}

# CPS patches (S3, S4, I1-I5) — for AWG 2+
if is_awg2_plus; then
  echo "Patching WireGuard.js for AWG 2+ (S3, S4, I1-I5)..."

  # Add S3, S4, I1-I5 to destructuring
  sed -i '/^  H4,$/a\  S3,\n  S4,\n  I1,\n  I2,\n  I3,\n  I4,\n  I5,' WireGuard.js

  # Add S3, S4, I1-I5 to server object
  sed -i '/^            h4: H4,$/a\            s3: S3,\n            s4: S4,\n            i1: I1,\n            i2: I2,\n            i3: I3,\n            i4: I4,\n            i5: I5,' WireGuard.js

  # Add S3, S4, I1-I5 to config template (conditional — skip empty values)
  sed -i '/^H4 = \${config\.server\.h4}$/a\${config.server.s3 ? `\\nS3 = ${config.server.s3}` : ""}\\\n${config.server.s4 ? `\\nS4 = ${config.server.s4}` : ""}\\\n${config.server.i1 ? `\\nI1 = ${config.server.i1}` : ""}\\\n${config.server.i2 ? `\\nI2 = ${config.server.i2}` : ""}\\\n${config.server.i3 ? `\\nI3 = ${config.server.i3}` : ""}\\\n${config.server.i4 ? `\\nI4 = ${config.server.i4}` : ""}\\\n${config.server.i5 ? `\\nI5 = ${config.server.i5}` : ""}' WireGuard.js

  echo "AWG 2+ CPS patches applied!"
else
  echo "AWG version $AWG_VERSION — skipping CPS patches"
fi

# AWG 3.0 patches (HeaderProtectionKey, ContentPadding, timers)
if is_awg3; then
  echo "Patching WireGuard.js for AWG 3.0 (HeaderProtectionKey, timers)..."

  # Add 3.0 params to destructuring (after I5)
  sed -i '/^  I5,$/a\  HEADER_PROTECTION_KEY,\n  CONTENT_PADDING_ADDITION,\n  REKEY_AFTER_TIME,\n  REKEY_TIMEOUT,\n  REJECT_AFTER_TIME,\n  KEEPALIVE_TIMEOUT,\n  MAX_HANDSHAKE_ATTEMPTS,' WireGuard.js

  # Add 3.0 params to server object (after i5)
  sed -i '/^            i5: I5,$/a\            headerProtectionKey: HEADER_PROTECTION_KEY,\n            contentPaddingAddition: CONTENT_PADDING_ADDITION,\n            rekeyAfterTime: REKEY_AFTER_TIME,\n            rekeyTimeout: REKEY_TIMEOUT,\n            rejectAfterTime: REJECT_AFTER_TIME,\n            keepaliveTimeout: KEEPALIVE_TIMEOUT,\n            maxHandshakeAttempts: MAX_HANDSHAKE_ATTEMPTS,' WireGuard.js

  # Add 3.0 params to config template (after I5 line in template)
  sed -i '/^\${config\.server\.i5 ? `\\nI5 = \${config\.server\.i5}` : ""}$/a\${config.server.headerProtectionKey ? `\\nHeaderProtectionKey = ${config.server.headerProtectionKey}` : ""}\\\n${config.server.contentPaddingAddition ? `\\nContentPaddingAddition = ${config.server.contentPaddingAddition}` : ""}\\\n${config.server.rekeyAfterTime ? `\\nRekeyAfterTime = ${config.server.rekeyAfterTime}` : ""}\\\n${config.server.rekeyTimeout ? `\\nRekeyTimeout = ${config.server.rekeyTimeout}` : ""}\\\n${config.server.rejectAfterTime ? `\\nRejectAfterTime = ${config.server.rejectAfterTime}` : ""}\\\n${config.server.keepaliveTimeout ? `\\nKeepaliveTimeout = ${config.server.keepaliveTimeout}` : ""}\\\n${config.server.maxHandshakeAttempts ? `\\nMaxHandshakeAttempts = ${config.server.maxHandshakeAttempts}` : ""}' WireGuard.js

  echo "AWG 3.0 patches applied!"
fi
