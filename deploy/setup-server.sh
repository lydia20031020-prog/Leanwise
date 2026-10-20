#!/usr/bin/env bash
# Run as root from Tencent Cloud command execution. No interactive prompts.
set -Eeuo pipefail
umask 0022

REPO_URL="${REPO_URL:-https://github.com/lydia20031020-prog/Leanwise.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-www.leanwise.lydiaowo.com}"
APP_DIR=/opt/leanwise

fail() { printf 'Leanwise: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || fail '请以 root 用户运行，或使用 sudo bash setup-server.sh。'
[[ -f /etc/os-release ]] || fail '无法识别系统。请先运行 cat /etc/os-release。'
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "当前系统为 ${PRETTY_NAME:-unknown}。自动安装仅支持 Ubuntu / Debian；请参阅 deploy/README.md，不会修改该系统。" ;;
esac
[[ -d /run/systemd/system ]] || fail '此脚本需要运行 systemd 的云服务器。'
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$DOMAIN" == *.* ]] || fail 'DOMAIN 必须是普通域名。'
[[ "$REPO_URL" == https://github.com/* && "$REPO_URL" != *'@'* && "$REPO_URL" != *'?'* ]] || fail 'REPO_URL 必须是不含账号、密钥或查询参数的 GitHub HTTPS 地址。'
[[ "$BRANCH" =~ ^[a-zA-Z0-9._/-]+$ && "$BRANCH" != -* ]] || fail 'BRANCH 格式无效。'
[[ ! -L "$APP_DIR" ]] || fail '/opt/leanwise 不能是指向其他目录的符号链接。'
[[ ! -L "$APP_DIR/releases" ]] || fail '/opt/leanwise/releases 不能是指向其他目录的符号链接。'

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg python3 util-linux debian-keyring debian-archive-keyring apt-transport-https
exec 9>/run/lock/leanwise-deploy.lock
flock -n 9 || fail '另一项 Leanwise 部署正在执行，请等待其完成。'

if [[ -x /usr/bin/node ]]; then
  /usr/bin/node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)' >/dev/null 2>&1 || fail '服务器已有较旧的 Node.js。为避免影响其他应用，脚本不会自动升级它。请先协调升级到 Node.js 22.12+ 后再运行。'
else
  node_setup=$(mktemp /tmp/leanwise-node-setup.XXXXXX)
  curl --fail --silent --show-error --location https://deb.nodesource.com/setup_22.x -o "$node_setup"
  bash "$node_setup"
  rm -f -- "$node_setup"
  apt-get install -y nodejs
fi
[[ -x /usr/bin/node ]] || fail 'Node.js 未成功安装到 /usr/bin/node。'
if ! command -v caddy >/dev/null 2>&1; then
  curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/releases"
staging=$(mktemp -d "$APP_DIR/releases/.staging.XXXXXX")
printf '下载 Leanwise %s 分支。失败时保留暂存目录：%s\n' "$BRANCH" "$staging"
git clone --depth 1 --single-branch --branch "$BRANCH" "$REPO_URL" "$staging"
[[ -f "$staging/deploy/common.sh" ]] || fail '仓库中缺少部署脚本。请确认代码已推送到选定分支。'
# shellcheck source=common.sh
. "$staging/deploy/common.sh"
check_layout
check_caddy_service
prepare_shared_environment
{
  printf 'REPO_URL=%q\n' "$REPO_URL"
  printf 'BRANCH=%q\n' "$BRANCH"
  printf 'DOMAIN=%q\n' "$DOMAIN"
} > /etc/leanwise/deploy.conf
chmod 0600 /etc/leanwise/deploy.conf
build_release "$staging"
activate_release "$RELEASE_DIR"
printf '\n部署程序已执行。下一步单独配置 API 密钥：\n'
printf 'bash /opt/leanwise/current/deploy/set-api-key.sh（用 README 中的非交互命令）\n'
printf '外网验收：bash /opt/leanwise/current/deploy/verify.sh\n'
