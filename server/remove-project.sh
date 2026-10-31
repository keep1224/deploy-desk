#!/usr/bin/env bash
# Remove one project that add-project.sh provisioned — the converse of it.
#   bash remove-project.sh <name>               # 删服务/目录/裸仓库/网站目录
#   bash remove-project.sh <name> --with-db     # 连 MySQL 库和账号一起删（不可恢复）
#
# nginx 站点不在这里删：apply.sh 是 deploy-*.conf 的唯一写入者，
# 从 projects.conf 移除该行后再跑一次 apply，站点自动下线。
set -euo pipefail

NAME=${1:?usage: remove-project.sh <name> [--with-db]}
WITH_DB=${2:-}

APPS_DIR=${APPS_DIR:-/opt/apps}
GIT_BASE=${GIT_BASE:-/opt/git}
SERVICE_PREFIX=${SERVICE_PREFIX:-nest-}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
WWW_DIR=${WWW_DIR:-/var/www}
MYSQL_HOST=${MYSQL_HOST:-127.0.0.1}
DB_PORT=3306

[[ $(id -u) -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ $NAME =~ ^[a-z][a-z0-9-]{2,30}$ ]] || { echo "invalid name: $NAME" >&2; exit 1; }
[[ -z $WITH_DB || $WITH_DB == '--with-db' ]] || { echo 'usage: remove-project.sh <name> [--with-db]' >&2; exit 1; }

APP=$APPS_DIR/$NAME
SERVICE=$SERVICE_PREFIX$NAME

# 数据库凭据要趁 .env 还在时读出来
DB_USER=''; DB_PASS=''; DB_NAME=''
if [[ -f $APP/.env ]]; then
  url=$(sed -n 's/^DATABASE_URL=//p' "$APP/.env" | tail -1 | tr -d "\"'")
  rest=${url#mysql://}
  if [[ $rest == *@* ]]; then
    userpass=${rest%%@*}
    DB_USER=${userpass%%:*}
    DB_PASS=${userpass#*:}
    [[ $DB_PASS == "$userpass" ]] && DB_PASS=''
    rest=${rest#*@}
    DB_NAME=${rest#*/}
    DB_NAME=${DB_NAME%%\?*}
  fi
fi

echo "==> systemd service"
if systemctl list-unit-files --type=service | grep -q "^$SERVICE\.service"; then
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/$SERVICE.service"
  systemctl daemon-reload
  echo "    removed $SERVICE.service"
else
  echo "    none"
fi

echo "==> bare repo"
if [[ -d $GIT_BASE/$NAME.git ]]; then
  rm -rf "$GIT_BASE/$NAME.git"
  echo "    removed $GIT_BASE/$NAME.git"
else
  echo "    none"
fi

echo "==> app dir"
if [[ -d $APP ]]; then
  rm -rf "$APP"
  echo "    removed $APP"
else
  echo "    none"
fi

echo "==> website dir"
for d in "$WWW_DIR/$NAME" "$WWW_DIR/$NAME.staging" "$WWW_DIR/$NAME.old"; do
  if [[ -d $d ]]; then
    rm -rf "$d"
    echo "    removed $d"
  fi
done

echo "==> system user"
if getent passwd "$NAME" >/dev/null; then
  userdel "$NAME" 2>/dev/null || echo "    warning: userdel failed（有进程占用？）" >&2
  if [[ -d /var/lib/$NAME ]]; then
    rm -rf "/var/lib/$NAME"
  fi
  echo "    removed user $NAME"
else
  echo "    none"
fi

if [[ $WITH_DB == '--with-db' ]]; then
  echo "==> database"
  if [[ -n ${DB_NAME:-} && -n ${DB_USER:-} ]]; then
    if MYSQL_PWD=${DB_PASS:-} mysql -h"$MYSQL_HOST" -P"$DB_PORT" -u"$DB_USER" \
      -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; DROP USER IF EXISTS '${DB_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;"; then
      echo "    dropped database $DB_NAME + user $DB_USER"
    else
      echo "    warning: database drop failed（账号权限或连接问题，可稍后手动删）" >&2
    fi
  else
    echo "    no DATABASE_URL recorded（db=none 或未初始化过）"
  fi
else
  echo "==> database kept（如需删除：bash remove-project.sh $NAME --with-db）"
fi

echo
echo "$NAME removed. nginx 站点会在下次「应用更改」时自动下线。"
