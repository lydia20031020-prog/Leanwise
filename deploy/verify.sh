#!/usr/bin/env bash
set -Eeuo pipefail
DOMAIN=www.leanwise.lydiaowo.com
if [[ ${EUID} -eq 0 && -f /etc/leanwise/deploy.conf ]]; then
  # shellcheck disable=SC1091
  . /etc/leanwise/deploy.conf
fi
printf '1. 服务状态\n'
systemctl is-active leanwise
systemctl is-active caddy
printf '\n2. 本机 API\n'
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8787/api/status
printf '\n\n3. 外网 HTTPS API（保留证书验证）\n'
curl --fail --silent --show-error --max-time 20 "https://${DOMAIN}/api/status"
printf '\n\n4. 网页响应\n'
curl --fail --silent --show-error --output /dev/null --write-out 'HTTP %{http_code}\n' --max-time 20 "https://${DOMAIN}/"
printf '\n以上通过后，请在浏览器完成一次真实文字解析、记录保存及刷新验证。\n'
