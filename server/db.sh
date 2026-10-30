#!/usr/bin/env bash
# Database helpers for the projects under /opt/apps.
#
#   db.sh list            # name<TAB>db<TAB>exists<TAB>size<TAB>tables
#   db.sh info <app>
#   db.sh migrate <app>   # pnpm exec prisma migrate deploy as the app user
#   db.sh dump <app>      # gzip dump into /var/backups/<app>-<ts>.sql.gz
#   db.sh import <app> <file>  # import a .sql / .sql.gz into the app database
#
# Credentials and host come from each project's .env DATABASE_URL, so a project
# can point at any reachable MySQL (127.0.0.1 by default).
set -euo pipefail

APPS_DIR=${APPS_DIR:-/opt/apps}
BACKUP_DIR=${BACKUP_DIR:-/var/backups}
MYSQL_HOST=${MYSQL_HOST:-127.0.0.1}

env_of() {
  sed -n "s/^$2=//p" "$APPS_DIR/$1/.env" 2>/dev/null | tail -1 | tr -d '"'"'"
}

# load <app> -> DB_USER DB_PASS DB_HOST DB_PORT DB_NAME
load() {
  local app=$1 url rest hostport
  [[ -f $APPS_DIR/$app/.env ]] || { echo "$app: 没有 .env" >&2; return 1; }
  url=$(env_of "$app" DATABASE_URL)
  [[ -n $url ]] || { echo "$app: DATABASE_URL 未配置" >&2; return 1; }
  rest=${url#mysql://}
  if [[ $rest == *@* ]]; then
    DB_USER=${rest%%:*}
    DB_PASS=${rest#*:}
    DB_PASS=${DB_PASS%%@*}
    rest=${rest#*@}
  else
    DB_USER=root
    DB_PASS=''
  fi
  hostport=${rest%%/*}
  DB_HOST=${hostport%%:*}
  DB_PORT=${hostport#*:}
  if [[ -z $DB_HOST || $DB_HOST == "$hostport" ]]; then
    DB_HOST=${MYSQL_HOST:-127.0.0.1}
    DB_PORT=3306
  fi
  DB_NAME=${rest#*/}
  DB_NAME=${DB_NAME%%\?*}
  [[ -n $DB_NAME ]] || { echo "$app: DATABASE_URL 里没有库名" >&2; return 1; }
}

q() { MYSQL_PWD=${DB_PASS:-} mysql -N -B -u"${DB_USER:-root}" -h"${DB_HOST:-127.0.0.1}" -P"${DB_PORT:-3306}" -e "$1" 2>/dev/null || true; }

cmd_list() {
  local app exists size tables
  for dir in "$APPS_DIR"/*/; do
    [[ -d $dir ]] || continue
    app=$(basename "$dir")
    if ! load "$app" 2>/dev/null; then
      printf '%s\t-\t-\t-\t-\n' "$app"
      continue
    fi
    exists=$(q "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'")
    size=$(q "SELECT IFNULL(ROUND(SUM(data_length+index_length)/1048576,1),0) FROM information_schema.tables WHERE table_schema='$DB_NAME'")
    tables=$(q "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME'")
    printf '%s\t%s\t%s\t%sMB\t%s\n' "$app" "$DB_NAME" \
      "$([[ ${exists:-0} == 1 ]] && echo yes || echo no)" "${size:-0}" "${tables:-0}"
  done
}

cmd_info() {
  local app=$1 exists size tables
  load "$app"
  exists=$(q "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'")
  size=$(q "SELECT IFNULL(ROUND(SUM(data_length+index_length)/1048576,1),0) FROM information_schema.tables WHERE table_schema='$DB_NAME'")
  tables=$(q "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME'")
  echo "app=$app"
  echo "db=$DB_NAME"
  echo "user=$DB_USER"
  echo "exists=$([[ ${exists:-0} == 1 ]] && echo yes || echo no)"
  echo "size=${size:-0}MB"
  echo "tables=${tables:-0}"
}

cmd_migrate() {
  local app=$1 home
  getent passwd "$app" >/dev/null || { echo "没有这个系统用户: $app" >&2; return 1; }
  [[ -f $APPS_DIR/$app/package.json ]] || { echo "$app: 还没部署代码（缺 package.json）" >&2; return 1; }
  home=/var/lib/$app
  install -d -o "$app" -g "$app" "$home"
  runuser -u "$app" -- env HOME="$home" \
    bash -c "cd '$APPS_DIR/$app' && pnpm exec prisma migrate deploy"
}

cmd_dump() {
  local app=$1 file
  load "$app"
  install -d "$BACKUP_DIR"
  file="$BACKUP_DIR/$app-$(date +%Y%m%d-%H%M%S).sql.gz"
  MYSQL_PWD=$DB_PASS mysqldump --single-transaction --quick --no-tablespaces \
    -u"$DB_USER" -h"$DB_HOST" -P"$DB_PORT" "$DB_NAME" | gzip -c > "$file"
  echo "备份完成: $file ($(du -h "$file" | cut -f1))"
}

cmd_import() {
  local app=$1 file=$2
  [[ -f $file ]] || { echo "没有这个文件: $file" >&2; return 1; }
  load "$app"
  if [[ $file == *.gz ]]; then
    gzip -dc "$file" | MYSQL_PWD=$DB_PASS mysql -u"$DB_USER" -h"$DB_HOST" -P"$DB_PORT" "$DB_NAME"
  else
    MYSQL_PWD=$DB_PASS mysql -u"$DB_USER" -h"$DB_HOST" -P"$DB_PORT" "$DB_NAME" < "$file"
  fi
  echo "导入完成: $app ← $(basename "$file")"
}

case ${1:-} in
  list) cmd_list ;;
  info) cmd_info "${2:?usage: db.sh info <app>}" ;;
  migrate) cmd_migrate "${2:?usage: db.sh migrate <app>}" ;;
  dump) cmd_dump "${2:?usage: db.sh dump <app>}" ;;
  import) cmd_import "${2:?usage: db.sh import <app> <file>}" "${3:?usage: db.sh import <app> <file>}" ;;
  *)
    echo 'usage: db.sh list | info <app> | migrate <app> | dump <app> | import <app> <file>' >&2
    exit 2
    ;;
esac
