#!/usr/bin/env bash
# Shared helpers; source from setup-server.sh or update-server.sh as root.
APP_DIR=/opt/leanwise
APP_USER=leanwise
ENV_FILE=/etc/leanwise/leanwise.env
SITE_FILE=/var/lib/leanwise/caddy/site.caddy
CADDY_MAIN=/etc/caddy/Caddyfile

fail() { printf 'Leanwise: %s\n' "$*" >&2; exit 1; }

check_layout() {
  [[ ! -L "$APP_DIR" && ! -L "$APP_DIR/releases" ]] || fail '应用目录不能是符号链接。'
  [[ ! -e "$APP_DIR/current" || -L "$APP_DIR/current" ]] || fail '/opt/leanwise/current 已是普通目录。请先将其迁移，不会覆盖。'
  if [[ -L "$APP_DIR/current" ]]; then
    local resolved
    resolved=$(readlink -f "$APP_DIR/current") || fail 'current 链接无效。'
    [[ "$resolved" == "$APP_DIR/releases/"* && -d "$resolved" ]] || fail 'current 链接必须位于 /opt/leanwise/releases/ 内。'
  fi
}

check_caddy_service() {
  local command
  command=$(systemctl show caddy --property=ExecStart --value)
  [[ "$command" == *'/etc/caddy/Caddyfile'* ]] || fail '现有 Caddy 服务使用其他配置路径；请先核对 systemctl cat caddy，不会覆盖配置。'
  if [[ -f "$CADDY_MAIN" ]]; then
    caddy validate --config "$CADDY_MAIN" --adapter caddyfile || fail '现有 Caddy 配置无效，请先修复；尚未修改任何网站。'
  fi
}

prepare_shared_environment() {
  [[ ! -L /etc/leanwise && ! -L "$ENV_FILE" ]] || fail '共享配置路径不能是符号链接。'
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  install -d -o root -g "$APP_USER" -m 0750 /etc/leanwise
  # Preserve a legacy server .env once; do not overwrite the shared file.
  if [[ ! -f "$ENV_FILE" && -f "$APP_DIR/.env" ]]; then
    install -o root -g "$APP_USER" -m 0640 "$APP_DIR/.env" "$ENV_FILE"
    printf '已保留旧服务器 .env，并迁移到 %s。\n' "$ENV_FILE"
  fi
  if [[ -f "$ENV_FILE" ]]; then
    chown root:"$APP_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
}

build_release() {
  local source_dir=$1 commit timestamp
  [[ "$source_dir" == "$APP_DIR/releases/.staging."* && -d "$source_dir/.git" ]] || fail '暂存路径无效。'
  [[ ! -e "$source_dir/.env" && ! -L "$source_dir/.env" ]] || fail '仓库包含 .env；必须先从仓库移除真实密钥。'
  (
    cd "$source_dir"
    npm ci --no-audit --no-fund
    npm test
    npm run build
  )
  if [[ -e "$source_dir/.git" ]]; then
    # Only the build output and application code are served; the repo remains root-owned.
    chmod 0700 "$source_dir/.git"
  fi
  ln -s "$ENV_FILE" "$source_dir/.env"
  commit=$(git -C "$source_dir" rev-parse --short=12 HEAD)
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  RELEASE_DIR="$APP_DIR/releases/${timestamp}-${commit}"
  [[ ! -e "$RELEASE_DIR" ]] || fail "版本目录已存在：$RELEASE_DIR。请稍后重试。"
  chmod 0755 "$source_dir"
  mv -- "$source_dir" "$RELEASE_DIR"
  printf '构建完成：%s\n' "$RELEASE_DIR"
}

switch_current() {
  local target=$1 link
  [[ "$target" == "$APP_DIR/releases/"* && -d "$target" ]] || fail '版本路径无效。'
  link="$APP_DIR/.current-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  ln -s "$target" "$link" || return 1
  mv -Tf -- "$link" "$APP_DIR/current" || return 1
}

wait_for_api() {
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8787/api/status >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

configure_caddy() {
  local release_dir=$1 backup candidate pending original_exists=0 old_site_exists=0 adapted
  backup="/var/backups/leanwise/caddy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -o root -g root -m 0700 "$backup" || return 1
  install -d -o root -g root -m 0755 /etc/caddy /var/lib/leanwise /var/lib/leanwise/caddy || return 1
  [[ ! -L "$CADDY_MAIN" && ! -L "$SITE_FILE" ]] || { printf 'Caddy 配置是符号链接，请核对真实路径。\n' >&2; return 1; }
  if [[ -f "$CADDY_MAIN" ]]; then
    original_exists=1
    cp -p -- "$CADDY_MAIN" "$backup/Caddyfile" || return 1
  else
    : > "$backup/Caddyfile" || return 1
  fi
  if [[ -f "$SITE_FILE" ]]; then
    old_site_exists=1
    cp -p -- "$SITE_FILE" "$backup/site.caddy" || return 1
  fi
  pending=$(mktemp /var/lib/leanwise/caddy/.pending.XXXXXX) || return 1
  sed "s/www\.leanwise\.lydiaowo\.com/${DOMAIN}/g" "$release_dir/deploy/Caddyfile" > "$pending" || return 1
  chmod 0644 "$pending" || return 1
  candidate=$(mktemp /etc/caddy/.leanwise-candidate.XXXXXX) || return 1
  adapted="$backup/adapted.json"
  if [[ $original_exists -eq 1 ]]; then
    caddy adapt --config "$CADDY_MAIN" --adapter caddyfile > "$adapted" || return 1
  else
    printf '{}' > "$adapted" || return 1
  fi
  if ! python3 "$release_dir/deploy/merge-caddy.py" "$backup/Caddyfile" "$candidate" "$DOMAIN" "$SITE_FILE" "$pending" "$adapted"; then
    printf '未修改 Caddy。请根据上方提示仅处理本站配置，然后重新运行部署。\n' >&2
    return 1
  fi
  if ! caddy validate --config "$candidate" --adapter caddyfile; then
    printf '候选配置校验失败；现有 Caddy 配置未修改。\n' >&2
    return 1
  fi
  if ! install -o root -g root -m 0644 "$pending" "$SITE_FILE"; then
    if [[ $old_site_exists -eq 1 ]]; then cp -p -- "$backup/site.caddy" "$SITE_FILE"; else rm -f -- "$SITE_FILE"; fi
    return 1
  fi
  if ! python3 - "$candidate" "$pending" "$SITE_FILE" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text(encoding='utf-8').replace(sys.argv[2], sys.argv[3]), encoding='utf-8')
PY
  then
    if [[ $old_site_exists -eq 1 ]]; then cp -p -- "$backup/site.caddy" "$SITE_FILE"; else rm -f -- "$SITE_FILE"; fi
    return 1
  fi
  if ! install -o root -g root -m 0644 "$candidate" "$CADDY_MAIN"; then
    if [[ $original_exists -eq 1 ]]; then cp -p -- "$backup/Caddyfile" "$CADDY_MAIN"; else rm -f -- "$CADDY_MAIN"; fi
    if [[ $old_site_exists -eq 1 ]]; then cp -p -- "$backup/site.caddy" "$SITE_FILE"; else rm -f -- "$SITE_FILE"; fi
    return 1
  fi
  if ! caddy validate --config "$CADDY_MAIN" --adapter caddyfile || ! systemctl reload caddy; then
    printf 'Caddy 应用失败，恢复备份：%s\n' "$backup" >&2
    if [[ $original_exists -eq 1 ]]; then cp -p -- "$backup/Caddyfile" "$CADDY_MAIN"; else rm -f -- "$CADDY_MAIN"; fi
    if [[ $old_site_exists -eq 1 ]]; then cp -p -- "$backup/site.caddy" "$SITE_FILE"; else rm -f -- "$SITE_FILE"; fi
    systemctl reload caddy || true
    return 1
  fi
  rm -f -- "$pending" "$candidate"
  printf '已合并本站 Caddy 配置，其他网站保留。配置备份：%s\n' "$backup"
}

activate_release() {
  local release_dir=$1 previous='' service_backup
  if [[ -L "$APP_DIR/current" ]]; then previous=$(readlink -f "$APP_DIR/current"); fi
  install -d -o root -g root -m 0700 /var/backups/leanwise || return 1
  service_backup="/var/backups/leanwise/leanwise.service-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  if [[ -f /etc/systemd/system/leanwise.service ]]; then cp -p /etc/systemd/system/leanwise.service "$service_backup" || return 1; fi
  install -o root -g root -m 0644 "$release_dir/deploy/leanwise.service" /etc/systemd/system/leanwise.service || return 1
  switch_current "$release_dir" || return 1
  systemctl daemon-reload || return 1
  systemctl enable leanwise || return 1
  if systemctl restart leanwise && wait_for_api && configure_caddy "$release_dir"; then
    printf '%s\n' "$previous" > /etc/leanwise/previous-release
    chmod 0600 /etc/leanwise/previous-release
    printf '本机 API 检查通过。HTTPS 证书可能仍在申请，请运行 verify.sh 验收。\n'
    return 0
  fi
  printf '部署应用失败，查看 journalctl -u leanwise -n 80 --no-pager。\n' >&2
  if [[ -n "$previous" ]]; then
    switch_current "$previous"
    if [[ -f "$service_backup" ]]; then cp -p "$service_backup" /etc/systemd/system/leanwise.service; systemctl daemon-reload; fi
    systemctl restart leanwise || true
    printf '已恢复上一版本：%s\n' "$previous" >&2
  else
    printf '首次安装保留本机服务以便排查，外网部署尚未完成。\n' >&2
  fi
  return 1
}
