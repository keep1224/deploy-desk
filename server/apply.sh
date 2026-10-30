#!/usr/bin/env bash
# Read projects.conf and converge the server to it: create whatever is missing,
# leave existing .env / databases untouched, and make nginx match the config.
#
#   bash apply.sh projects.conf
#
# Run as root on the server. See projects.conf for the column format.
#
# --- nginx ownership -------------------------------------------------------
# This script is the ONLY writer of deploy vhosts. Rules it follows:
#   * one file per project: <conf.d>/deploy-<name>.conf, so a single project can
#     be written, compared, removed or rolled back on its own
#   * a file is ours only if it matches deploy-*.conf; anything else in conf.d
#     (hand-written vhosts, certbot output) is never touched
#   * a project dropped from projects.conf gets its file deleted -> real converge
#   * nginx -t runs BEFORE the reload, and on failure this run's changes are
#     rolled back, so a bad config can never take the whole server down
#
# TLS is out of scope on purpose: run 'certbot certonly --webroot' (it only
# touches /etc/letsencrypt) and add a listen 443 server block in a file that
# does not match deploy-*.conf.
set -euo pipefail

CONF=${1:?usage: apply.sh <projects.conf>}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPS_DIR=${APPS_DIR:-/opt/apps}
SITES_DIR=${SITES_DIR:-/etc/nginx/conf.d}
SITE_PREFIX=${SITE_PREFIX:-deploy-}
LEGACY_CONF=${LEGACY_CONF:-$SITES_DIR/projects.conf}

[[ $(id -u) -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ -f $CONF ]] || { echo "no such file: $CONF" >&2; exit 1; }

declare -A TYPE=() PORT=() DOMAIN=() API=() DBCOL=()
order=()

echo "==> reading $CONF"
while read -r name type port domain api db rest; do
  [[ -z ${name:-} || $name == \#* ]] && continue
  [[ -z ${type:-} ]] && continue

  [[ $name =~ ^[a-z][a-z0-9-]{2,30}$ ]] || { echo "bad name: $name" >&2; exit 1; }
  [[ -n ${TYPE[$name]:-} ]] && { echo "duplicate project: $name" >&2; exit 1; }
  [[ $type == api || $type == web ]] || { echo "$name: type must be api or web, got '$type'" >&2; exit 1; }
  [[ ${db:-mysql} =~ ^(mysql|none)$ || ${db:-mysql} =~ ^[a-z][a-z0-9_]{2,30}$ ]] \
    || { echo "$name: bad db '${db}'(mysql / none / 库名)" >&2; exit 1; }

  # 域名列可以带 http(s):// 和结尾斜杠，nginx 的 server_name 只认主机名
  domain=${domain#http://}
  domain=${domain#https://}
  domain=${domain%/}

  TYPE[$name]=$type
  PORT[$name]=${port:--}
  DOMAIN[$name]=${domain:--}
  API[$name]=${api:--}
  DBCOL[$name]=${db:-mysql}
  order+=("$name")
done < "$CONF"

[[ ${#order[@]} -gt 0 ]] || { echo 'no projects in config' >&2; exit 1; }

echo "==> checking for conflicts"
declare -A by_port=() by_domain=()
for name in "${order[@]}"; do
  if [[ ${PORT[$name]} != - ]]; then
    [[ ${PORT[$name]} =~ ^[0-9]+$ ]] || { echo "$name: bad port ${PORT[$name]}" >&2; exit 1; }
    [[ -n ${by_port[${PORT[$name]}]:-} ]] \
      && { echo "port ${PORT[$name]} used by both $name and ${by_port[${PORT[$name]}]}" >&2; exit 1; }
    by_port[${PORT[$name]}]=$name
  fi
  if [[ ${DOMAIN[$name]} != - ]]; then
    [[ -n ${by_domain[${DOMAIN[$name]}]:-} ]] \
      && { echo "domain ${DOMAIN[$name]} used by both $name and ${by_domain[${DOMAIN[$name]}]}" >&2; exit 1; }
    by_domain[${DOMAIN[$name]}]=$name
  fi
done

for name in "${order[@]}"; do
  if [[ ${TYPE[$name]} == web && ${API[$name]} != - ]]; then
    [[ -n ${TYPE[${API[$name]}]:-} ]] \
      || { echo "$name: api '${API[$name]}' is not defined in the config" >&2; exit 1; }
    [[ ${TYPE[${API[$name]}]} == api ]] \
      || { echo "$name: '${API[$name]}' is not an api project" >&2; exit 1; }
  fi
done

# PORT=3001, PORT="3001" and PORT=3001 # comment all yield 3001
port_of() {
  awk -F= '/^PORT=/{gsub(/[^0-9]/, "", $2); print $2; exit}' "$APPS_DIR/$1/.env" 2>/dev/null
}

# ---------------------------------------------------------------------------
# nginx: one file per project
# ---------------------------------------------------------------------------

SITE_FILES=()
CREATED_SITES=()
CHANGED_NGINX=no

site_file() { printf '%s/%s%s.conf' "$SITES_DIR" "$SITE_PREFIX" "$1"; }

# Render the vhost for one project.
#   api: everything goes to the backend, so /health, /api-docs and /metrics work
#   web: static root + SPA fallback, /api/ proxied when an api project is set
site_render() { # <out> <name> <type> <domain> <upstream>
  local out=$1 name=$2 type=$3 domain=$4 upstream=${5:-}
  {
    printf '# managed by deploy/apply.sh - rewritten on every apply, do not edit\n'
    printf '# project: %s (%s)\n' "$name" "$type"
    printf 'server {\n'
    printf '    listen 80;\n'
    printf '    server_name %s;\n' "$domain"
    if [[ $type == api ]]; then
      printf '\n    location / {\n'
      printf '        proxy_pass http://127.0.0.1:%s;\n' "$upstream"
      printf '        proxy_http_version 1.1;\n'
      printf '        proxy_set_header Host $host;\n'
      printf '        proxy_set_header X-Real-IP $remote_addr;\n'
      printf '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
      printf '        proxy_set_header X-Forwarded-Proto $scheme;\n'
      printf '        proxy_read_timeout 300s;\n'
      printf '    }\n'
    else
      printf '    root /var/www/%s;\n    index index.html;\n' "$name"
      printf '\n    location / { try_files $uri $uri/ /index.html; }\n'
      if [[ -n $upstream ]]; then
        printf '\n    location /api/ {\n'
        printf '        proxy_pass http://127.0.0.1:%s;\n' "$upstream"
        printf '        proxy_http_version 1.1;\n'
        printf '        proxy_set_header Host $host;\n'
        printf '        proxy_set_header X-Real-IP $remote_addr;\n'
        printf '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        printf '        proxy_set_header X-Forwarded-Proto $scheme;\n'
        printf '        proxy_read_timeout 300s;\n'
        printf '    }\n'
      fi
    fi
    printf '}\n'
  } > "$out"
}

site_write() { # <name> <type> <domain> <upstream>
  local f
  f=$(site_file "$1")
  SITE_FILES+=("$f")

  site_render "$f.tmp" "$1" "$2" "$3" "${4:-}"
  if [[ ! -f $f ]]; then
    CREATED_SITES+=("$f")
    mv "$f.tmp" "$f"
    echo "    nginx created: $f"
    CHANGED_NGINX=yes
  elif cmp -s "$f.tmp" "$f"; then
    rm -f "$f.tmp"
    echo "    nginx unchanged: $f"
  else
    mv "$f.tmp" "$f"
    echo "    nginx updated: $f"
    CHANGED_NGINX=yes
  fi
}

site_remove() { # <file>
  [[ -f $1 ]] || return 0
  rm -f "$1"
  echo "    nginx removed: $1"
  CHANGED_NGINX=yes
}

# Test first; on failure undo this run's nginx changes. A bad config then never
# reaches disk, and the previously working sites stay as they were.
nginx_commit() {
  [[ $CHANGED_NGINX == yes ]] || return 0

  echo "==> nginx"
  if nginx -t; then
    systemctl reload nginx
    return 0
  fi

  echo 'nginx -t failed - rolling back every nginx change made by this run' >&2
  local f
  for f in "${CREATED_SITES[@]:-}"; do
    [[ -n $f ]] || continue
    rm -f "$f"
    echo "    reverted (new):  $f" >&2
  done
  if [[ -d $BACKUP_DIR ]]; then
    for f in "$BACKUP_DIR"/*; do
      [[ -f $f ]] || continue
      cp -p "$f" "$SITES_DIR/$(basename "$f")"
      echo "    restored:        $SITES_DIR/$(basename "$f")" >&2
    done
  fi
  nginx -t >/dev/null 2>&1 || echo 'WARNING: nginx still fails to test after rollback' >&2
  return 1
}

BACKUP_DIR=$(mktemp -d)
trap 'rm -rf "$BACKUP_DIR"' EXIT

install -d "$SITES_DIR"

# Snapshot every vhost we own BEFORE touching anything. CREATED_SITES covers
# files that did not exist yet; this covers every file that did.
for f in "$SITES_DIR/$SITE_PREFIX"*.conf; do
  [[ -f $f ]] && cp -p "$f" "$BACKUP_DIR/$(basename "$f")"
done

# One-time migration: the old single-file layout also defined these vhosts, and
# two files cannot own the same server_name. Everything it held is regenerated
# below, so it is disabled (not deleted) and a reload is scheduled.
if [[ -f $LEGACY_CONF ]]; then
  echo "==> migrating legacy $LEGACY_CONF"
  mv "$LEGACY_CONF" "$BACKUP_DIR/$(basename "$LEGACY_CONF")"
  echo "    moved to backup; every vhost in it is regenerated below"
  CHANGED_NGINX=yes
fi

echo "==> api projects"
for name in "${order[@]}"; do
  [[ ${TYPE[$name]} == api ]] || continue
  echo "  $name"
  port_arg=''
  [[ ${PORT[$name]} != - ]] && port_arg=${PORT[$name]}
  domain_arg=''
  [[ ${DOMAIN[$name]} != - ]] && domain_arg=${DOMAIN[$name]}
  bash "$HERE/add-project.sh" "$name" "$port_arg" "$domain_arg" "${DBCOL[$name]}"
done

echo "==> web projects"
for name in "${order[@]}"; do
  [[ ${TYPE[$name]} == web ]] || continue
  echo "  $name"
  [[ ${DOMAIN[$name]} != - ]] || { echo "    web project needs a domain" >&2; exit 1; }
  install -d "/var/www/$name"

  upstream=''
  if [[ ${API[$name]} != - ]]; then
    upstream=$(port_of "${API[$name]}")
    [[ -n $upstream ]] \
      || { echo "    cannot read PORT from $APPS_DIR/${API[$name]}/.env" >&2; exit 1; }
  fi
  site_write "$name" web "${DOMAIN[$name]}" "$upstream"
done

echo "==> api domains"
for name in "${order[@]}"; do
  [[ ${TYPE[$name]} == api && ${DOMAIN[$name]} != - ]] || continue
  echo "  $name"
  upstream=$(port_of "$name")
  [[ -n $upstream ]] || { echo "    cannot read PORT from $APPS_DIR/$name/.env" >&2; exit 1; }
  site_write "$name" api "${DOMAIN[$name]}" "$upstream"
done

echo "==> stale sites"
STALE=0
for f in "$SITES_DIR/$SITE_PREFIX"*.conf; do
  [[ -f $f ]] || continue
  keep=no
  for k in "${SITE_FILES[@]:-}"; do
    [[ -n $k && $k == "$f" ]] && { keep=yes; break; }
  done
  [[ $keep == yes ]] && continue
  site_remove "$f"
  STALE=$((STALE + 1))
done
[[ $STALE -eq 0 ]] && echo '  none'

if ! nginx_commit; then
  echo 'apply aborted: nginx config was NOT applied (server left as it was)' >&2
  exit 1
fi

echo
echo 'converged. deploy each api project with:'
for name in "${order[@]}"; do
  [[ ${TYPE[$name]} == api ]] && echo "  git push deploy master    # $name -> /opt/git/$name.git"
done
