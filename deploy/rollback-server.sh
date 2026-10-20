#!/usr/bin/env bash
set -Eeuo pipefail
[[ ${EUID} -eq 0 ]] || { echo '请以 root 用户运行。' >&2; exit 1; }
exec 9>/run/lock/leanwise-deploy.lock
flock -n 9 || { echo '另一项 Leanwise 部署正在执行。' >&2; exit 1; }
# shellcheck source=common.sh
. /opt/leanwise/current/deploy/common.sh
check_layout
[[ -s /etc/leanwise/previous-release ]] || fail '没有可回滚的上一版本。'
IFS= read -r target < /etc/leanwise/previous-release
[[ "$target" == "$APP_DIR/releases/"* && -f "$target/server/index.js" ]] || fail '上一版本路径无效或目录已不存在。'
current=$(readlink -f "$APP_DIR/current")
switch_current "$target"
if systemctl restart leanwise && wait_for_api; then
  printf '%s\n' "$current" > /etc/leanwise/previous-release
  printf '已回滚到 %s。服务器密钥、Caddy 配置与本机记录均保留。\n' "$target"
else
  switch_current "$current"
  systemctl restart leanwise || true
  fail '回滚版本未正常启动，已恢复原版本。'
fi
