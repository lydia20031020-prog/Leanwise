# Leanwise 网站部署（腾讯云命令执行）

目标网站：`https://www.leanwise.lydiaowo.com`，服务器：`43.143.208.73`（Windows Server）。
仓库：`https://github.com/lydia20031020-prog/Leanwise`，需公开可读且已推送到 `main`。

网页记录保存在当前浏览器 `localStorage`，小程序记录保存在当前手机 `wx.setStorageSync`，服务器不保存个人记录。刷新和服务更新不会清除这些记录；清理浏览器数据、卸载小程序或换设备后不会自动恢复，请使用应用内导出备份。

## Windows Server（当前服务器）

部署脚本：[windows/leanwise.ps1](windows/leanwise.ps1)。它会：

- 在 `C:\Leanwise` 下安装固定版本的 Node.js 22、Caddy 和 WinSW，下载后逐个校验 SHA-256；不修改服务器上已有的 Node.js。
- 从 GitHub 下载源码，执行 `npm ci`、测试和构建，全部通过后才切换版本。
- 注册两个 Windows 服务：`LeanwiseApi`（仅监听 `127.0.0.1:8787`）和 `LeanwiseCaddy`（80/443，自动申请 HTTPS 证书）。
- 密钥只保存在 `C:\Leanwise\config\leanwise.env`，仅 SYSTEM 与管理员可读。
- 若 80/443 已被 IIS 或其他程序占用，会在修改任何内容之前停止。

腾讯云控制台进入此服务器的「命令执行」，命令类型选 **PowerShell**，执行用户保持默认（SYSTEM），超时设为 **3600 秒**。每个步骤单独创建一次任务。

### 1. 下载脚本并检查环境（只读）

```powershell
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force C:\Leanwise | Out-Null
$target = 'C:\Leanwise\leanwise.ps1'
$sources = @(
  'https://raw.githubusercontent.com/lydia20031020-prog/Leanwise/main/deploy/windows/leanwise.ps1',
  'https://cdn.jsdelivr.net/gh/lydia20031020-prog/Leanwise@main/deploy/windows/leanwise.ps1'
)
$ok = $false
foreach ($u in $sources) {
  try { Invoke-WebRequest -Uri $u -OutFile $target -UseBasicParsing -TimeoutSec 60; $ok = $true; Write-Host "downloaded: $u"; break }
  catch { Write-Host "failed: $u $($_.Exception.Message)" }
}
if (-not $ok) { throw 'download failed' }
powershell -NoProfile -ExecutionPolicy Bypass -File $target -Action Check
exit $LASTEXITCODE
```

脚本会显示系统版本、端口占用、DNS 和外网连通情况，不修改服务器。继续之前确认：

- 80/443/2019/8787 均未被占用。若显示 PID 4 或 IIS（W3SVC）在运行，先确认这台服务器上没有需要保留的 IIS 网站。
- 域名解析到 `43.143.208.73`。
- GitHub 与 nodejs.org（或 npmmirror）可访问。

### 2. 部署（首次安装和以后更新都用这条）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Leanwise\leanwise.ps1 -Action Deploy
exit $LASTEXITCODE
```

首次执行需下载约 60 MB 并安装依赖，通常需要 5–15 分钟。末尾会自动执行一次验收。

### 3. 配置 DeepSeek 密钥

把 `sk-在这里替换为完整密钥` 换成你的完整密钥后执行。腾讯云命令内容对有控制台权限的人可见，不要截图或放进 GitHub。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Leanwise\leanwise.ps1 -Action SetKey -ApiKey 'sk-在这里替换为完整密钥'
exit $LASTEXITCODE
```

也可以远程桌面登录服务器，用记事本编辑 `C:\Leanwise\config\leanwise.env` 中的 `DEEPSEEK_API_KEY=`，然后执行 `Restart-Service LeanwiseApi`。

### 4. 验收

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Leanwise\leanwise.ps1 -Action Verify
exit $LASTEXITCODE
```

两个服务都应为 `Running`，本机 API 返回 `configured: true`，HTTPS 两项为 `HTTP 200`。Caddy 首次申请证书可能需要 1–2 分钟。仍失败时依次排查：

- 腾讯云安全组入站放行 TCP 80、443。
- DNS 的 A 记录 `www.leanwise` 指向 `43.143.208.73`。
- 中国大陆服务器的域名需完成 ICP 备案，否则 80/443 访问会被拦截，证书也申请不到。

然后在浏览器完成：文字输入食物 → 核对营养 → 保存 → 刷新确认记录仍在 → 保存体重/目标 → 向顾问提问。

### 日常维护

```powershell
# 查看服务、版本、端口和最近日志
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Leanwise\leanwise.ps1 -Action Status

# 回滚到上一版本（再执行一次会切回）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Leanwise\leanwise.ps1 -Action Rollback
```

GitHub `main` 更新后重新执行第 2 步。新版本测试和构建通过、本机 API 启动成功后才切换；失败会自动恢复上一版本。保留最近 5 个版本，密钥与证书不受更新影响。日志位于 `C:\Leanwise\logs`。

## Linux（Ubuntu / Debian）备用

若以后换成 Linux 服务器，以 root 执行：

```bash
set -eu
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/lydia20031020-prog/Leanwise/main/deploy/setup-server.sh \
  -o /tmp/leanwise-setup-server.sh
bash /tmp/leanwise-setup-server.sh
```

之后：密钥用 `bash /opt/leanwise/current/deploy/set-api-key.sh`（从标准输入读取），验收 `deploy/verify.sh`，更新 `deploy/update-server.sh`，回滚 `deploy/rollback-server.sh`。脚本使用 systemd + Caddy，密钥在 `/etc/leanwise/leanwise.env`。

## 微信小程序

微信开发者工具导入仓库的 `miniprogram` 目录，AppID 使用 `wx5971d92eb86b0234`。网站 HTTPS 验收通过后，在微信公众平台「开发管理 → 开发设置 → 服务器域名」将 `https://www.leanwise.lydiaowo.com` 加入 request 合法域名，再真机预览与上传。详见 [../miniprogram/README.md](../miniprogram/README.md)。
