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
#   * a site toggled off in the panel sits in $DISABLED_DIR; apply rewrites it
#     there and never moves it back, so 下线 survives every apply
#   * nginx -t runs BEFORE the reload, and on failure this run's changes are
#     rolled back, so a bad config can never take the whole server down
#
# TLS is out of scope on purpose: run 'certbot certonly --webroot' (it only
# touches /etc/letsencrypt) and add a listen 443 server block in a file that
# does not match deploy-*.conf.
#
# --- per-project extras -----------------------------------------------------
# If $SNIPPET_DIR/<name>.conf exists it is included INSIDE that project's
# server block, so gzip, cache headers, extra locations or a second listen can
# be added without giving up convergence: the generated part is still rewritten
# every apply, the snippet is never touched by this script.
set -euo pipefail

CONF=${1:?usage: apply.sh <projects.conf>}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPS_DIR=${APPS_DIR:-/opt/apps}
SITES_DIR=${SITES_DIR:-/etc/nginx/conf.d}
SITE_PREFIX=${SITE_PREFIX:-deploy-}
# 面板里点了「下线」的站点，vhost 文件搬到这里（不在 conf.d 的 include 范围内）。
# apply 时同名文件会被重新渲染到这里，而不是拉回 conf.d —— 下线状态跨应用保持。
DISABLED_DIR=${DISABLED_DIR:-/etc/nginx/deploy-disabled}
LEGACY_CONF=${LEGACY_CONF:-$SITES_DIR/projects.conf}
# Per-project escape hatch: drop <name>.conf here and it gets included inside
# that project's server block. Never written by this script, so it survives
# every apply. Anything that needs more than the 6 columns goes here.
SNIPPET_DIR=${SNIPPET_DIR:-/opt/deploy/snippets}

[[ $(id -u) -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ -f $CONF ]] || { echo "no such file: $CONF" >&2; exit 1; }

declare -A TYPE=() PORT=() DOMAIN=() API=() DBCOL=()
order=()

echo "==> reading $CONF"
# 末行没有换行符时 read 返回非 0，但变量里仍是最后一行，所以补一次判断，
# 否则清单里最后一个项目会被静默跳过。
# shellcheck disable=SC2034  # rest 有意吞掉行内注释等尾随列
while read -r name type port domain api db rest || [[ -n ${name:-} ]]; do
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
declare -A by_port=() domain_rows=()
for name in "${order[@]}"; do
  if [[ ${PORT[$name]} != - ]]; then
    [[ ${PORT[$name]} =~ ^[0-9]+$ ]] || { echo "$name: bad port ${PORT[$name]}" >&2; exit 1; }
    [[ -n ${by_port[${PORT[$name]}]:-} ]] \
      && { echo "port ${PORT[$name]} used by both $name and ${by_port[${PORT[$name]}]}" >&2; exit 1; }
    by_port[${PORT[$name]}]=$name
  fi
  [[ ${DOMAIN[$name]} != - ]] && domain_rows[${DOMAIN[$name]}]+="$name "
done

# 同一域名被多行使用只放行一种场合：每行都是 web 且都写了显式端口——
# 没有 DNS 的服务器（域名就是 IP）靠 listen 端口区分站点，nginx 对
# 「同 server_name、不同 listen」本来就不告警。api 行的端口是后端自己的
# 监听端口、站点永远 listen 80，掺进来必然撞端口，所以不允许。
# 端口互不相同由上面的 by_port 全局唯一保证。
for d in "${!domain_rows[@]}"; do
  read -ra users <<< "${domain_rows[$d]}"
  (( ${#users[@]} > 1 )) || continue
  shareable=yes
  for u in "${users[@]}"; do
    [[ ${TYPE[$u]} == web && ${PORT[$u]} != - ]] || { shareable=no; break; }
  done
  if [[ $shareable == yes ]]; then
    echo "    note: $d shared by ${users[*]} (distinguished by listen ports)"
  else
    echo "domain $d used by multiple projects (${users[*]});" >&2
    echo "sharing a domain requires every row to be web with an explicit distinct port" >&2
    exit 1
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
#        listen comes from the port column (default 80) - it is the public port
#        nginx serves the site on, nothing else ever binds to it
site_render() { # <out> <name> <type> <domain> <upstream> [listen]
  local out=$1 name=$2 type=$3 domain=$4 upstream=${5:-} listen=${6:-80}
  {
    printf '# managed by deploy/apply.sh - rewritten on every apply, do not edit\n'
    # 版本标记：换脚本后能一眼看出这份文件是谁生成的（v2 = web 端口列即 listen 端口）
    printf '# schema v2 - web port column is the nginx listen port\n'
    printf '# project: %s (%s)\n' "$name" "$type"
    printf 'server {\n'
    printf '    listen %s;\n' "$listen"
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
    # Hand-written extras live outside this file, so apply never eats them.
    if [[ -f $SNIPPET_DIR/$name.conf ]]; then
      printf '\n    # extras - hand written, not managed by apply.sh\n'
      printf '    include %s/%s.conf;\n' "$SNIPPET_DIR" "$name"
    fi
    printf '}\n'
  } > "$out"
}

site_write() { # <name> <type> <domain> <upstream> [listen]
  local f
  f=$(site_file "$1")
  SITE_FILES+=("$f")

  # 下线中的站点：渲染结果直接写进 disabled 目录，conf.d 里不出现，
  # 所以 apply 不会把用户刻意关掉的站点重新上线。
  local target=$f
  if [[ -f $DISABLED_DIR/$SITE_PREFIX$1.conf ]]; then
    target=$DISABLED_DIR/$SITE_PREFIX$1.conf
    install -d "$DISABLED_DIR"
  fi

  site_render "$target.tmp" "$1" "$2" "$3" "${4:-}" "${5:-80}"
  if [[ ! -f $target ]]; then
    CREATED_SITES+=("$target")
    mv "$target.tmp" "$target"
    echo "    nginx created: $target"
    CHANGED_NGINX=yes
  elif cmp -s "$target.tmp" "$target"; then
    rm -f "$target.tmp"
    echo "    nginx unchanged: $target"
  else
    mv "$target.tmp" "$target"
    echo "    nginx updated: $target"
    CHANGED_NGINX=yes
  fi
  # 末行不能用 "test && echo" 的短路写法：无 snippet（默认）时该式返回 1，
  # 在 set -e 下会让 site_write 返回 1、进而中止整个 apply。改成 if 形式，恒返回 0。
  if [[ -f $SNIPPET_DIR/$1.conf ]]; then
    echo "    + extras: $SNIPPET_DIR/$1.conf"
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
install -d "$SNIPPET_DIR"

# Snapshot every vhost we own BEFORE touching anything. CREATED_SITES covers
# files that did not exist yet; this covers every file that did.
for f in "$SITES_DIR/$SITE_PREFIX"*.conf; do
  [[ -f $f ]] && cp -p "$f" "$BACKUP_DIR/$(basename "$f")"
done

# One-time migration: the old single-file layout also defined these vhosts, and
# two files cannot own the same server_name. The file is renamed out of nginx's
# include glob (conf.d/*.conf) but kept on disk — nothing in it is lost. Every
# vhost it held is regenerated below from the project list.
if [[ -f $LEGACY_CONF ]]; then
  kept="$LEGACY_CONF.migrated-$(date +%Y%m%d-%H%M%S)"
  echo "==> migrating legacy $LEGACY_CONF"
  mv "$LEGACY_CONF" "$kept"
  echo "    kept as $kept (no longer loaded); every vhost in it is regenerated below"
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
  # web has no process of its own, so the port column is the nginx listen port
  listen=80
  [[ ${PORT[$name]} != - ]] && listen=${PORT[$name]}
  site_write "$name" web "${DOMAIN[$name]}" "$upstream" "$listen"
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
if [[ $STALE -eq 0 ]]; then
  echo '  none'
fi

# 项目从清单里删掉后，它下线时留下的 disabled 配置也一并清理
if [[ -d $DISABLED_DIR ]]; then
  for f in "$DISABLED_DIR/$SITE_PREFIX"*.conf; do
    [[ -f $f ]] || continue
    keep=no
    for k in "${SITE_FILES[@]:-}"; do
      [[ -n $k && "$SITES_DIR/$(basename "$f")" == "$k" ]] && { keep=yes; break; }
    done
    [[ $keep == yes ]] && continue
    rm -f "$f"
    echo "    nginx removed (disabled): $f"
  done
fi

if ! nginx_commit; then
  echo 'apply aborted: nginx config was NOT applied (server left as it was)' >&2
  exit 1
fi

echo
echo 'converged. deploy each api project with:'
for name in "${order[@]}"; do
  # 用 if 而不是 "[[ ]] && echo"：web 行让短路式返回 1，
  # 它是脚本最后一条命令，会让成功的 apply 以退出码 1 结束。
  if [[ ${TYPE[$name]} == api ]]; then
    echo "  git push deploy master    # $name -> /opt/git/$name.git"
  fi
done
