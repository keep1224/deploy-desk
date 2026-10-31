#!/usr/bin/env bash
# Provision one backend project on this server: system user, app dir, bare repo
# + post-receive hook, systemd unit, .env, and the MySQL database/user.
#
#   bash add-project.sh api-b                       # port auto-picked from 3001
#   bash add-project.sh api-b 3002                  # pin the port
#   bash add-project.sh api-b 3002 api-b.example.com # domain only feeds CORS here
#
# Safe to re-run: an existing .env and database are left alone, while the hook
# and the service unit are rewritten to match the arguments.
#
# nginx is NOT handled here. apply.sh owns every vhost (one file per project,
# see its header), so this script never writes to /etc/nginx.
set -euo pipefail

NAME=${1:?usage: add-project.sh <name> [port] [domain] [db]}
PORT_ARG=${2:-}
DOMAIN=${3:-}
DB_ARG=${4:-}

# 域名参数允许带 http(s):// 和结尾斜杠，写进 CORS 前统一成主机名
DOMAIN=${DOMAIN#http://}
DOMAIN=${DOMAIN#https://}
DOMAIN=${DOMAIN%/}

# db argument: mysql (default, name derived from the project), none, or a name.
case $DB_ARG in
  ''|mysql) DB=${NAME//-/_}; DB_ENABLED=true ;;
  none)     DB='';            DB_ENABLED=false ;;
  *)        DB=$DB_ARG;       DB_ENABLED=true ;;
esac
if [[ $DB_ENABLED == true && ! $DB =~ ^[a-z][a-z0-9_]{2,30}$ ]]; then
  echo "invalid db name: $DB (mysql, none, or lowercase a-z0-9_)" >&2
  exit 1
fi
DB_USER=${DB_USER:-${DB:-$NAME}}

APPS_DIR=${APPS_DIR:-/opt/apps}
GIT_BASE=${GIT_BASE:-/opt/git}
SHARED_HOOK=${SHARED_HOOK:-/opt/deploy/post-receive}
SERVICE_PREFIX=${SERVICE_PREFIX:-nest-}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
MEM_MAX=${MEM_MAX:-384M}
MIN_PORT=${MIN_PORT:-3001}
# 运行时服务堆上限（MB）。默认 256M：给 384M 的 cgroup MemoryMax 留出非堆开销
# 余量，避免 Node 在触顶 OOM 前被 systemd 先杀掉。这只写进 .env 供运行态使用；
# 构建阶段（post-receive 里的 pnpm build）另用更大的堆，互不影响。
RUNTIME_HEAP_MB=${RUNTIME_HEAP_MB:-256}

[[ $(id -u) -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ $NAME =~ ^[a-z][a-z0-9-]{2,30}$ ]] || { echo "invalid name: $NAME" >&2; exit 1; }
NODE_BIN=$(command -v node) || { echo 'node not found in PATH' >&2; exit 1; }
command -v pnpm >/dev/null || echo 'warning: pnpm not in PATH; the hook will fail' >&2

APP=$APPS_DIR/$NAME
SERVICE=$SERVICE_PREFIX$NAME
BARE=$GIT_BASE/$NAME.git

# PORT for the hook comes from .env when it already exists, so re-running this
# script can never renumber a live service behind its systemd unit's back.
env_port() {
  awk -F= '/^PORT=/{gsub(/[^0-9]/, "", $2); print $2; exit}' "$APP/.env" 2>/dev/null
}

if [[ -n $PORT_ARG ]]; then
  PORT=$PORT_ARG
  if command -v ss >/dev/null && ss -lntH "sport = :$PORT" | grep -q .; then
    echo "note: port $PORT already listening (fine on re-run)" >&2
  fi
else
  PORT=$(env_port)
  if [[ -z $PORT ]]; then
    PORT=$MIN_PORT
    if command -v ss >/dev/null; then
      while ss -lntH "sport = :$PORT" | grep -q .; do PORT=$((PORT + 1)); done
    fi
  fi
fi
[[ $PORT =~ ^[0-9]{2,5}$ ]] || { echo "invalid port: $PORT" >&2; exit 1; }

echo "==> user + dirs"
getent passwd "$NAME" >/dev/null \
  || useradd --system --shell /usr/sbin/nologin --home-dir "$APP" --no-create-home "$NAME"
install -d -o "$NAME" -g "$NAME" "$APP"
install -d "$GIT_BASE" "$(dirname "$SHARED_HOOK")"

echo "==> shared hook"
if [[ ! -f $SHARED_HOOK ]]; then
  install -m 0755 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/post-receive" "$SHARED_HOOK"
fi

echo "==> bare repo + hook"
git init --bare --initial-branch=master "$BARE" >/dev/null
cat > "$BARE/hooks/post-receive" <<EOF
#!/bin/sh
export APP_DIR=$APP
export SERVICE=$SERVICE
export PORT=$PORT
exec $SHARED_HOOK
EOF
chmod 0755 "$BARE/hooks/post-receive"

echo "==> systemd unit"
cat > "$SYSTEMD_DIR/$SERVICE.service" <<EOF
[Unit]
Description=$NAME (NestJS)
After=network.target mysql.service

[Service]
Type=simple
User=$NAME
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
ExecStart=$NODE_BIN --enable-source-maps dist/main.js
Restart=on-failure
RestartSec=3
MemoryMax=$MEM_MAX

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

echo "==> database + .env"
if [[ -f $APP/.env ]]; then
  echo "    .env exists, left untouched (database/user not re-created)"
  [[ $(env_port) == "$PORT" ]] \
    || echo "    warning: .env PORT=$(env_port) differs from $PORT used by the hook" >&2
else
  DB_PASS=$(openssl rand -hex 16)
  CORS=${DOMAIN:+https://$DOMAIN}
  CORS=${CORS:-*}
  if [[ $DB_ENABLED == true ]]; then
    DB_ENV="DATABASE_ENABLED=true
DATABASE_URL=\"mysql://$DB_USER:$DB_PASS@127.0.0.1:3306/$DB?connectionLimit=10&charset=utf8mb4\""
  else
    DB_ENV='DATABASE_ENABLED=false'
  fi
  cat > "$APP/.env" <<EOF
NODE_ENV=production
PORT=$PORT
LOG_LEVEL=info
$DB_ENV
TRUST_PROXY=true
CORS_ORIGINS=$CORS
BODY_LIMIT=1mb
SWAGGER_ENABLED=true
SWAGGER_PATH=api-docs
# 运行时堆上限：小于 systemd 的 MemoryMax(${MEM_MAX})，避免 cgroup OOM 先于 JS 堆 OOM
NODE_OPTIONS=--max-old-space-size=${RUNTIME_HEAP_MB}
JWT_SECRET="$(openssl rand -hex 32)"
JWT_EXPIRES_IN=7d
EOF
  chown "$NAME:$NAME" "$APP/.env"
  chmod 600 "$APP/.env"

  if [[ $DB_ENABLED == true ]]; then
    mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT ALL ON \`$DB\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
    echo "    database $DB + user $DB_USER created; password is in $APP/.env"
  else
    echo '    database skipped (db=none); .env has DATABASE_ENABLED=false'
  fi
fi

cat <<EOF

$NAME ready
  app dir   : $APP
  service   : $SERVICE (port $PORT, MemoryMax $MEM_MAX)
  bare repo : $BARE
  database  : ${DB:-（未启用）}

local side:
  git remote add deploy ssh://root@<host>:<port>$BARE
  git push deploy master
EOF
