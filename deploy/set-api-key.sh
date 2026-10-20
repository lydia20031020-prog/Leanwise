#!/usr/bin/env bash
# Read a key from stdin. Never print it; works in non-interactive cloud tasks.
set +x
set -Eeuo pipefail
[[ ${EUID} -eq 0 ]] || { echo '请以 root 用户运行。' >&2; exit 1; }
[[ -f /opt/leanwise/current/deploy/common.sh ]] || { echo '请先完成首次部署。' >&2; exit 1; }
exec 9>/run/lock/leanwise-deploy.lock
flock -n 9 || { echo '另一项 Leanwise 部署正在执行。' >&2; exit 1; }
# shellcheck source=common.sh
. /opt/leanwise/current/deploy/common.sh
IFS= read -r API_KEY || [[ -n "${API_KEY:-}" ]]
[[ "$API_KEY" =~ ^sk-[A-Za-z0-9_-]{16,}$ ]] || fail '密钥格式无效。请替换 README 中的占位符，输入完整的 DeepSeek 密钥。'
prepare_shared_environment
temp_env=$(mktemp /etc/leanwise/.env-pending.XXXXXX)
backup=/etc/leanwise/.env-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$
if [[ -f "$ENV_FILE" ]]; then
  cp -- "$ENV_FILE" "$backup"
  chmod 0600 "$backup"
  awk '!/^[[:space:]]*(export[[:space:]]+)?DEEPSEEK_API_KEY[[:space:]]*=/' "$ENV_FILE" > "$temp_env"
fi
printf '\nDEEPSEEK_API_KEY=%s\n' "$API_KEY" >> "$temp_env"
unset API_KEY
for setting in 'DEEPSEEK_BASE_URL=https://api.deepseek.com' 'DEEPSEEK_MODEL=deepseek-flash' 'PORT=8787' 'HOST=127.0.0.1'; do
  name=${setting%%=*}
  if ! grep -Eq "^[[:space:]]*${name}=" "$temp_env"; then printf '%s\n' "$setting" >> "$temp_env"; fi
done
chown root:leanwise "$temp_env"
chmod 0640 "$temp_env"
mv -f -- "$temp_env" "$ENV_FILE"
if ! systemctl restart leanwise || ! wait_for_api; then
  if [[ -f "$backup" ]]; then
    install -o root -g leanwise -m 0640 "$backup" "$ENV_FILE"
    systemctl restart leanwise || true
    printf '服务重启失败，已恢复之前的密钥配置。\n' >&2
  fi
  exit 1
fi
printf 'API 密钥已保存到服务器并重启。configured=true 只表示已配置，还需在网页发起一次文字解析验证认证：\n'
curl --fail --silent --show-error http://127.0.0.1:8787/api/status
printf '\n'
