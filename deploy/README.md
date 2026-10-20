# Leanwise 网站部署（腾讯云命令执行）

目标网站：`https://www.leanwise.lydiaowo.com`，服务器：`43.143.208.73`。
仓库：`https://github.com/lydia20031020-prog/Leanwise`。必须先完成代码推送。下列命令用于服务器，不用于本机 PowerShell。

本 Demo 的网页记录保存在当前浏览器 `localStorage`，小程序记录保存在当前设备 `wx.setStorageSync`。刷新和服务更新不会主动清除这些记录；清理浏览器数据、卸载小程序或换设备后不会自动恢复。当前没有账号与云端数据库。
小米/华为健康为演示同步；照片可上传并补充文字、手动核对，当前 DeepSeek 模型的图片识别不可用。真实文字解析与 AI 顾问通过服务器调用 DeepSeek。

## 1. 确认服务器环境

腾讯云控制台进入此服务器的「命令执行」，选择 Shell，以 `root` 身份执行。每个步骤分别创建任务，安装任务超时建议设为 1800 秒。

```bash
whoami
cat /etc/os-release
systemctl show caddy --property=ExecStart --value
getent ahostsv4 www.leanwise.lydiaowo.com
```

自动安装支持 Ubuntu / Debian 且需 systemd。若显示 TencentOS、CentOS、Rocky 等其他系统，脚本会在修改系统前停止；保留本步骤输出以便按该系统适配，不要直接运行 apt 命令或重装服务器。已有 Caddy 服务需要使用 `/etc/caddy/Caddyfile`。
DNS 的 A 记录应指向 `43.143.208.73`，腾讯云安全组和服务器防火墙须允许公网 TCP 80、443；API 的 8787 仅监听本机，不需开放。已有网站继续使用 Caddy，部署只添加/替换 Leanwise 的独立站点块。

## 2. 首次安装

以下命令要求仓库公开可读，当前脚本通过 HTTPS 下载源码。单独配置 SSH Deploy Key 不能授权这组 HTTPS 命令。若仓库为私有，请先将不含密钥的 Demo 仓库设为公开，或另行使用认证下载流程；不能把 GitHub Token 填进 URL 或提交到项目。

```bash
set -eu
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/lydia20031020-prog/Leanwise/main/deploy/setup-server.sh \
  -o /tmp/leanwise-setup-server.sh
bash /tmp/leanwise-setup-server.sh
```

脚本安装 Node.js 22 和 Caddy（已有 Caddy则保留），下载代码、安装依赖、执行测试和构建，并启动 `leanwise` 服务。如果服务器已有低于 Node.js 22.12 的版本，会停止并提示先协调升级，避免自动影响其他 Node 应用。
代码存于 `/opt/leanwise/releases/版本号`，`/opt/leanwise/current` 指向当前版本。不会清空 `/opt/leanwise`，不会执行 `git reset --hard`。
服务器密钥统一保存在 `/etc/leanwise/leanwise.env`；如果服务器已有 `/opt/leanwise/.env`，会一次性迁移并保留原文件。更新不覆盖密钥。
Caddy 的本站文件是 `/var/lib/leanwise/caddy/site.caddy`，主文件通过 `import` 引入。修改前会备份到 `/var/backups/leanwise`，校验成功后才 reload；不会直接用仓库中的片段覆盖整个主配置。

若安装提示「本站位于 import 文件」或「与其他域名共享块」，原配置保持不变。先定位：

```bash
grep -R -n -- 'www.leanwise.lydiaowo.com' /etc/caddy
systemctl cat caddy
```

用控制台编辑配置：将本站完整的独立站点块从 import 文件移动到 `/etc/caddy/Caddyfile`，保留其他域名、全局设置与原有 import。若本站和其他域名共享块，原块只保留其他域名，并在主文件追加下面的本站块；原先仅属于本站的块从原位置移除，避免重复域名。若原配置来自通配符，需先让通配符规则排除/拆出本站，不要直接删除通配符网站。

```caddyfile
www.leanwise.lydiaowo.com {
    reverse_proxy 127.0.0.1:8787
}
```

此时先不 reload Caddy。主文件的这个独立块会由部署脚本迁移到本站片段。校验并完成部署：

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
bash /opt/leanwise/current/deploy/update-server.sh
```

## 3. 配置 DeepSeek 密钥（支持无交互执行）

将下面唯一的占位行替换成你自己的完整 DeepSeek API Key，然后作为独立 Shell 任务执行。脚本不会打印密钥，但腾讯云命令任务正文会对有控制台权限的人员可见；实际密钥只填在自己的控制台，不放进 GitHub、截图或网页代码。

```bash
set +x
bash /opt/leanwise/current/deploy/set-api-key.sh <<'LEANWISE_API_KEY'
在这里替换为完整的DeepSeek密钥
LEANWISE_API_KEY
```

成功后输出 `/api/status`。`configured: true` 表示服务读到了配置；还需从网页发起一次真实文字解析确认密钥认证和账户余额。当前模型保持 `deepseek-flash`，不会自动切换模型。

## 4. 验收 HTTPS 和实际功能

```bash
bash /opt/leanwise/current/deploy/verify.sh
```

应看到两个服务 `active`、本机和 HTTPS API 均返回 JSON，网页 `HTTP 200`。API 中应有 `configured: true`、`provider: "deepseek"`、`healthMode: "demo"`。
Caddy 首次申请证书可能需要短暂等待；若 HTTPS 失败，先排查以下输出，不要用 `curl -k` 绕过证书验证：

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl status leanwise caddy --no-pager -l
journalctl -u leanwise -n 80 --no-pager
journalctl -u caddy -n 100 --no-pager
ss -lntp
getent ahostsv4 www.leanwise.lydiaowo.com
```

如果本机 API 正常但 HTTPS 失败，重点查看 Caddy 的证书错误、80/443 安全组与 DNS。域名用于中国大陆服务器时还需满足腾讯云实际备案要求。

打开网站完成：文字输入食物 → 核对营养 → 保存 → 刷新确认记录仍在 → 修改一次个人食物数据并复用 → 保存体重/目标 → 向顾问提问。模拟健康数据应始终显示演示标识。

## 5. 后续更新与回滚

GitHub `main` 分支更新后执行：

```bash
bash /opt/leanwise/current/deploy/update-server.sh
```

新版本先测试和构建，再切换 current 并检查本机服务。失败时自动恢复上一版本；旧版本、密钥和本机记录保留。部署不会清理旧版本，可在确认使用稳定后由你按实际磁盘占用管理。

手动回滚上一版本：

```bash
bash /opt/leanwise/current/deploy/rollback-server.sh
bash /opt/leanwise/current/deploy/verify.sh
```

只修改 API 密钥时重新执行第 3 步。无需重新构建网页。

## 6. 微信小程序

微信开发者工具导入仓库的 `miniprogram` 目录，AppID 使用 `wx5971d92eb86b0234`。
在微信公众平台「开发管理 → 开发设置 → 服务器域名」中将 `https://www.leanwise.lydiaowo.com` 加入 `request` 合法域名；HTTPS 网站验收通过后再真机预览与上传。
小程序仅保存本机记录，调用相同服务器 API。RSA 上传私钥不能放进仓库或小程序前端；当前无微信账号登录，不需要 AppSecret。上传与正式发布仍需微信开发者权限及平台审核。
