#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${INSTALL_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3003}"
DATA_DIR="${DATA_DIR:-$INSTALL_ROOT/data}"
ENV_PATH="${ENV_PATH:-$INSTALL_ROOT/.env.local}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
DEPLOY_DIR="$INSTALL_ROOT/.deploy"

mkdir -p "$DEPLOY_DIR"
cp "$SCRIPT_DIR/boot-shim.mjs" "$DEPLOY_DIR/boot-shim.mjs"

INSTALL_ROOT="$INSTALL_ROOT" \
HOST="$HOST" \
PORT="$PORT" \
DATA_DIR="$DATA_DIR" \
ENV_PATH="$ENV_PATH" \
"$NODE_BIN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const installRoot = path.resolve(process.env.INSTALL_ROOT);
const config = {
  installRoot,
  host: process.env.HOST,
  port: Number(process.env.PORT),
  dataDir: path.resolve(process.env.DATA_DIR),
  envPath: path.resolve(process.env.ENV_PATH),
  entry: 'daemon/server.mjs',
  flags: {
    routineTicker: true,
    buildRunner: false,
  },
};

fs.writeFileSync(
  path.join(installRoot, '.deploy', 'config.json'),
  `${JSON.stringify(config, null, 2)}\n`,
);
NODE

cat <<EOF
Installed boot shim:
  $DEPLOY_DIR/boot-shim.mjs
  $DEPLOY_DIR/config.json

Founder-applied plist safety-floor change only. Do not automate this edit.
In ops/ch.holonresear.cs-k-daemon.plist, change ProgramArguments to:

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>.deploy/boot-shim.mjs</string>
    </array>

Keep WorkingDirectory as:
    <string>$INSTALL_ROOT</string>

Keep KeepAlive=true.
EOF
