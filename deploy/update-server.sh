#!/usr/bin/env bash
set -Eeuo pipefail
umask 0022
[[ ${EUID} -eq 0 ]] || { echo '请以 root 用户运行。' >&2; exit 1; }
[[ -f /etc/leanwise/deploy.conf && -f /opt/leanwise/current/deploy/common.sh ]] || { echo '请先运行 setup-server.sh 完成首次部署。' >&2; exit 1; }
exec 9>/run/lock/leanwise-deploy.lock
flock -n 9 || { echo '另一项 Leanwise 部署正在执行。' >&2; exit 1; }
# shellcheck disable=SC1091
. /etc/leanwise/deploy.conf
APP_DIR=/opt/leanwise
staging=$(mktemp -d "$APP_DIR/releases/.staging.XXXXXX")
printf '下载更新。失败时保留暂存目录：%s\n' "$staging"
git clone --depth 1 --single-branch --branch "$BRANCH" "$REPO_URL" "$staging"
# Use helpers from the newly downloaded revision.
# shellcheck source=common.sh
. "$staging/deploy/common.sh"
check_layout
check_caddy_service
prepare_shared_environment
build_release "$staging"
activate_release "$RELEASE_DIR"
printf '\n更新完成，旧版本和服务器密钥均已保留。\n'
bash "$RELEASE_DIR/deploy/verify.sh"
