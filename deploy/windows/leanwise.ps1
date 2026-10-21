<#
Leanwise 网站部署：Windows Server + 腾讯云「命令执行」（PowerShell，SYSTEM 或管理员）。

  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Leanwise\leanwise.ps1 -Action Check
  ... -Action Deploy              首次安装与后续更新（同一命令）
  ... -Action SetKey -ApiKey sk-  配置 DeepSeek 密钥
  ... -Action Verify | Status | Rollback

布局：C:\Leanwise\{tools,releases,config,data,logs,service,state}
服务：LeanwiseApi（Node，仅监听 127.0.0.1:8787）、LeanwiseCaddy（80/443，自动 HTTPS）
密钥只在 config\leanwise.env（仅 SYSTEM 与管理员可读），不进入仓库或网页。
#>
param(
    [ValidateSet('Check', 'Deploy', 'SetKey', 'Verify', 'Status', 'Rollback')]
    [string]$Action = 'Check',
    [string]$ApiKey = '',
    [string]$Root = 'C:\Leanwise',
    [string]$Domain = 'www.leanwise.lydiaowo.com',
    [string]$ServerIp = '43.143.208.73',
    [string]$Repo = 'lydia20031020-prog/Leanwise',
    [string]$Branch = 'main'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Pinned downloads. Hashes were checked against the official release files;
# mirrors are safe to try because every file must match the same SHA-256.
$Pinned = @{
    Node  = @{
        Version = 'v22.23.4'
        Sha256  = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
        Urls    = @(
            'https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip',
            'https://registry.npmmirror.com/-/binary/node/v22.23.4/node-v22.23.4-win-x64.zip'
        )
    }
    Caddy = @{
        Version = '2.11.7'
        Sha256  = '0a1edc0b799512051c57071ce0e798d3f2cf67dc98171366f1d2b326072e3b06'
        Urls    = @('https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip')
    }
    WinSW = @{
        Version = '2.12.0'
        Sha256  = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f'
        Urls    = @('https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe')
    }
}

$ApiService = 'LeanwiseApi'
$CaddyService = 'LeanwiseCaddy'
$ToolsDir = Join-Path $Root 'tools'
$CacheDir = Join-Path $Root 'cache'
$ReleasesDir = Join-Path $Root 'releases'
$ConfigDir = Join-Path $Root 'config'
$DataDir = Join-Path $Root 'data'
$LogDir = Join-Path $Root 'logs'
$ServiceDir = Join-Path $Root 'service'
$StateDir = Join-Path $Root 'state'
$EnvFile = Join-Path $ConfigDir 'leanwise.env'
$CaddyFile = Join-Path $ConfigDir 'Caddyfile'
$NodeDir = Join-Path $ToolsDir "node-$($Pinned.Node.Version)"
$NodeExe = Join-Path $NodeDir 'node.exe'
$NpmCmd = Join-Path $NodeDir 'npm.cmd'
$CaddyDir = Join-Path $ToolsDir "caddy-$($Pinned.Caddy.Version)"
$CaddyExe = Join-Path $CaddyDir 'caddy.exe'
$WinswExe = Join-Path $ToolsDir "winsw-$($Pinned.WinSW.Version).exe"

function Write-Step([string]$Message) { Write-Host ''; Write-Host "== $Message" }
function Write-Info([string]$Message) { Write-Host "   $Message" }

function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Read-Text([string]$Path) {
    if (Test-Path -LiteralPath $Path) { return [IO.File]::ReadAllText($Path) }
    return ''
}

function Get-State([string]$Name) { return (Read-Text (Join-Path $StateDir $Name)).Trim() }
function Set-State([string]$Name, [string]$Value) { Write-Utf8 (Join-Path $StateDir $Name) $Value }

# Native tools write progress and warnings to stderr. When the cloud agent
# redirects stderr, PowerShell 5.1 would turn that into terminating errors.
function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host "   $_" }
    return $LASTEXITCODE
}

function Save-Url([string]$Url, [string]$OutFile) {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
        $code = Invoke-Native $curl @('-fsSL', '--retry', '3', '--retry-delay', '3', '--connect-timeout', '20', '--max-time', '1200', '-o', $OutFile, $Url)
        if ($code -ne 0) { throw "curl 退出码 $code" }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 1200
    }
}

function Get-VerifiedFile([hashtable]$Item, [string]$FileName) {
    $target = Join-Path $CacheDir $FileName
    if ((Test-Path -LiteralPath $target) -and ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $Item.Sha256)) { return $target }
    $failures = @()
    foreach ($url in $Item.Urls) {
        $partial = "$target.part"
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        Write-Info "下载 $url"
        try {
            Save-Url $url $partial
            $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash
            if ($hash -ne $Item.Sha256) { throw "SHA-256 不匹配：$($hash)" }
            Move-Item -LiteralPath $partial -Destination $target -Force
            return $target
        } catch {
            $failures += "$url -> $($_.Exception.Message)"
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        }
    }
    throw "无法下载并校验 $($FileName)：`n$($failures -join "`n")"
}

function Expand-Zip([string]$Zip, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

function Get-PortOwners([int[]]$Ports) {
    $owners = @()
    foreach ($port in $Ports) {
        $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        foreach ($owner in @($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
            $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
            $path = ''
            $name = '?'
            if ($process) {
                $name = $process.ProcessName
                try { $path = [string]$process.Path } catch { $path = '' }
            }
            $owners += [pscustomobject]@{ Port = $port; Pid = $owner; Name = $name; Path = $path }
        }
    }
    return $owners
}

function Resolve-IPv4([string]$Name) {
    try {
        return @([Net.Dns]::GetHostAddresses($Name) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.IPAddressToString })
    } catch { return @() }
}

function Test-Url([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 20
        return "可访问 HTTP $($response.StatusCode)"
    } catch {
        $response = $_.Exception.Response
        if ($response) { return "可访问 HTTP $([int]$response.StatusCode)" }
        return "失败 $($_.Exception.Message)"
    }
}

function Get-NetFrameworkRelease {
    $key = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue
    if ($key -and $key.Release) { return [int]$key.Release }
    return 0
}

function Assert-Platform {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请以管理员或 SYSTEM 身份运行（腾讯云命令执行默认即 SYSTEM）。' }
    if (-not [Environment]::Is64BitOperatingSystem) { throw '需要 64 位 Windows。' }
    $build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
    if ($build -lt 14393) { throw "Windows build $build 过旧；Node.js 22 需要 Windows Server 2016 或更新版本。" }
    if ((Get-NetFrameworkRelease) -lt 394254) { throw '需要 .NET Framework 4.6.1 或更新版本（服务管理组件 WinSW 依赖）。' }
}

function Assert-PortsFree {
    Write-Step '检查端口 80/443/2019/8787'
    $conflicts = @(Get-PortOwners @(80, 443, 2019, 8787) | Where-Object { -not ($_.Path -and $_.Path -like "$ToolsDir\*") })
    if ($conflicts.Count -eq 0) { Write-Info '未发现其他程序占用。'; return }
    foreach ($item in $conflicts) { Write-Info "端口 $($item.Port) 被占用：PID $($item.Pid) $($item.Name) $($item.Path)" }
    if ($conflicts | Where-Object { $_.Pid -eq 4 }) { Write-Info 'PID 4 是 Windows HTTP.sys，通常来自 IIS（W3SVC）或其他 HTTP 服务。' }
    throw '端口已被其他程序占用。为避免影响现有网站，部署已停止，没有修改任何服务。'
}

function Initialize-Layout {
    foreach ($dir in @($Root, $ToolsDir, $CacheDir, $ReleasesDir, $ConfigDir, $DataDir, $LogDir, $ServiceDir, $StateDir)) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    }
    # config holds the API key; data holds TLS private keys. SYSTEM + Administrators only.
    foreach ($dir in @($ConfigDir, $DataDir)) {
        $code = Invoke-Native (Join-Path $env:SystemRoot 'System32\icacls.exe') @($dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q')
        if ($code -ne 0) { throw "无法设置目录权限：$dir" }
    }
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        Write-Utf8 $EnvFile "DEEPSEEK_API_KEY=`nDEEPSEEK_BASE_URL=https://api.deepseek.com`nDEEPSEEK_MODEL=deepseek-flash`n"
    }
}

function Install-Tools {
    Write-Step '准备运行环境（固定版本，SHA-256 校验）'
    if (-not (Test-Path -LiteralPath $NodeExe)) {
        $zip = Get-VerifiedFile $Pinned.Node "node-$($Pinned.Node.Version)-win-x64.zip"
        $temp = Join-Path $ToolsDir '.node-extract'
        Expand-Zip $zip $temp
        if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
        Move-Item -LiteralPath (Join-Path $temp "node-$($Pinned.Node.Version)-win-x64") -Destination $NodeDir
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
    Write-Info "Node.js $(& $NodeExe --version)"
    if (-not (Test-Path -LiteralPath $CaddyExe)) {
        $zip = Get-VerifiedFile $Pinned.Caddy "caddy_$($Pinned.Caddy.Version)_windows_amd64.zip"
        Expand-Zip $zip $CaddyDir
    }
    Write-Info "Caddy $(& $CaddyExe version)"
    if (-not (Test-Path -LiteralPath $WinswExe) -or (Get-FileHash -LiteralPath $WinswExe -Algorithm SHA256).Hash -ne $Pinned.WinSW.Sha256) {
        $file = Get-VerifiedFile $Pinned.WinSW 'WinSW.NET461.exe'
        Copy-Item -LiteralPath $file -Destination $WinswExe -Force
    }
    Write-Info "WinSW $($Pinned.WinSW.Version)"
}

function Get-RemoteCommit {
    try {
        $info = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'leanwise-deploy' }
        if ([string]$info.sha -match '^[0-9a-f]{40}$') { return [string]$info.sha }
    } catch {
        Write-Info "无法从 GitHub API 获取提交号（$($_.Exception.Message)），改用 $Branch 分支最新代码。"
    }
    return ''
}

function New-Release {
    Write-Step '下载源码、测试并构建'
    $commit = Get-RemoteCommit
    $ref = $Branch
    $short = 'branch'
    if ($commit) { $ref = $commit; $short = $commit.Substring(0, 12) }
    $id = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + "-$short"
    $releaseDir = Join-Path $ReleasesDir $id
    $zip = Join-Path $CacheDir "source-$id.zip"
    $extract = Join-Path $ReleasesDir ".extract-$id"
    Write-Info "源码 $Repo@$ref"
    Save-Url "https://codeload.github.com/$Repo/zip/$ref" $zip
    Expand-Zip $zip $extract
    $inner = @(Get-ChildItem -LiteralPath $extract -Directory)
    if ($inner.Count -ne 1) { throw '源码压缩包结构异常。' }
    Move-Item -LiteralPath $inner[0].FullName -Destination $releaseDir
    Remove-Item -LiteralPath $extract -Recurse -Force
    Remove-Item -LiteralPath $zip -Force
    foreach ($file in @('package.json', 'package-lock.json', 'server\index.js', 'deploy\Caddyfile')) {
        if (-not (Test-Path -LiteralPath (Join-Path $releaseDir $file))) { throw "源码缺少 $file，请确认代码已推送到 $Branch。" }
    }
    if (Test-Path -LiteralPath (Join-Path $releaseDir '.env')) { throw '仓库包含 .env；请先从仓库移除真实密钥。' }
    Write-Info "版本目录：$releaseDir"

    $env:Path = "$NodeDir;$env:Path"
    $env:npm_config_cache = Join-Path $CacheDir 'npm'
    $env:npm_config_update_notifier = 'false'
    $env:npm_config_fund = 'false'
    $env:npm_config_audit = 'false'
    Push-Location -LiteralPath $releaseDir
    try {
        Write-Info 'npm ci'
        $code = Invoke-Native $NpmCmd @('ci')
        if ($code -ne 0) {
            Write-Info '官方 npm 源安装失败，改用 npmmirror 镜像重试（仍按 package-lock 校验完整性）。'
            $code = Invoke-Native $NpmCmd @('ci', '--registry=https://registry.npmmirror.com')
            if ($code -ne 0) { throw "npm ci 失败（退出码 $code）。" }
        }
        Write-Info 'npm test'
        $code = Invoke-Native $NpmCmd @('test')
        if ($code -ne 0) { throw "测试失败（退出码 $code），未切换版本。" }
        Write-Info 'npm run build'
        $code = Invoke-Native $NpmCmd @('run', 'build')
        if ($code -ne 0) { throw "构建失败（退出码 $code），未切换版本。" }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath (Join-Path $releaseDir 'dist\index.html'))) { throw '构建输出缺少 dist\index.html。' }
    Write-Utf8 (Join-Path $releaseDir '.leanwise-built') $id
    return $releaseDir
}

function Get-ApiServiceXml([string]$ReleaseDir) {
    $entry = Join-Path $ReleaseDir 'server\index.js'
    return @"
<service>
  <id>$ApiService</id>
  <name>Leanwise API</name>
  <description>Leanwise Node.js API and web frontend on 127.0.0.1:8787</description>
  <executable>$NodeExe</executable>
  <arguments>--env-file=$EnvFile $entry</arguments>
  <workingdirectory>$ReleaseDir</workingdirectory>
  <env name="NODE_ENV" value="production"/>
  <env name="HOST" value="127.0.0.1"/>
  <env name="PORT" value="8787"/>
  <env name="LEANWISE_TRUST_PROXY" value="loopback"/>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$LogDir</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
</service>
"@
}

function Get-CaddyServiceXml {
    return @"
<service>
  <id>$CaddyService</id>
  <name>Leanwise Caddy</name>
  <description>HTTPS reverse proxy for $Domain to 127.0.0.1:8787</description>
  <executable>$CaddyExe</executable>
  <arguments>run --config $CaddyFile --adapter caddyfile</arguments>
  <workingdirectory>$ConfigDir</workingdirectory>
  <env name="XDG_DATA_HOME" value="$DataDir"/>
  <env name="XDG_CONFIG_HOME" value="$DataDir"/>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$LogDir</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
</service>
"@
}

# Returns $true when the service definition changed.
function Write-ServiceFiles([string]$Id, [string]$Xml) {
    $exe = Join-Path $ServiceDir "$Id.exe"
    if (-not (Test-Path -LiteralPath $exe)) { Copy-Item -LiteralPath $WinswExe -Destination $exe }
    $xmlPath = Join-Path $ServiceDir "$Id.xml"
    if ((Read-Text $xmlPath) -ceq $Xml) { return $false }
    Write-Utf8 $xmlPath $Xml
    return $true
}

function Wait-PortFree([int]$Port) {
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Seconds 1
    }
    throw "端口 $Port 仍被占用，无法启动新版本。"
}

function Restart-LeanwiseService([string]$Id) {
    $service = Get-Service -Name $Id -ErrorAction SilentlyContinue
    if (-not $service) {
        $code = Invoke-Native (Join-Path $ServiceDir "$Id.exe") @('install')
        if ($code -ne 0) { throw "无法安装服务 $Id。" }
    } elseif ($service.Status -ne 'Stopped') {
        Stop-Service -Name $Id -Force
    }
    if ($Id -eq $ApiService) { Wait-PortFree 8787 }
    Start-Service -Name $Id
}

function Test-LocalApi {
    try {
        return ((Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/status' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200)
    } catch { return $false }
}

function Wait-Api {
    for ($i = 0; $i -lt 45; $i++) {
        if (Test-LocalApi) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Show-LogTail([string]$Name, [int]$Lines) {
    $path = Join-Path $LogDir $Name
    if (-not (Test-Path -LiteralPath $path)) { return }
    Write-Info "--- $Name"
    Get-Content -LiteralPath $path -Tail $Lines -Encoding UTF8 | ForEach-Object { Write-Host "   $_" }
}

function Switch-ApiRelease([string]$ReleaseDir) {
    Write-Step '切换 API 服务'
    $current = Get-State 'current'
    Write-ServiceFiles $ApiService (Get-ApiServiceXml $ReleaseDir) | Out-Null
    Restart-LeanwiseService $ApiService
    if (Wait-Api) {
        if ($current -and $current -ne $ReleaseDir) { Set-State 'previous' $current }
        Set-State 'current' $ReleaseDir
        Write-Info "本机 API 正常：$ReleaseDir"
        return
    }
    Write-Info '新版本未能启动，最近日志：'
    Show-LogTail "$ApiService.err.log" 30
    Show-LogTail "$ApiService.wrapper.log" 10
    if ($current -and (Test-Path -LiteralPath $current)) {
        Write-ServiceFiles $ApiService (Get-ApiServiceXml $current) | Out-Null
        Restart-LeanwiseService $ApiService
        if (Wait-Api) { Write-Info "已恢复上一版本：$current" } else { Write-Info '上一版本也未能启动，请查看 Status 日志。' }
    }
    throw '新版本未通过本机 API 检查，部署已停止。'
}

function Set-CaddySite([string]$ReleaseDir) {
    Write-Step '配置 HTTPS（Caddy）'
    $env:XDG_DATA_HOME = $DataDir
    $env:XDG_CONFIG_HOME = $DataDir
    $site = Read-Text (Join-Path $ReleaseDir 'deploy\Caddyfile')
    if ($Domain -ne 'www.leanwise.lydiaowo.com') { $site = $site.Replace('www.leanwise.lydiaowo.com', $Domain) }
    $candidate = Join-Path $ConfigDir 'Caddyfile.candidate'
    Write-Utf8 $candidate $site
    $code = Invoke-Native $CaddyExe @('validate', '--config', $candidate, '--adapter', 'caddyfile')
    if ($code -ne 0) { throw 'Caddy 配置校验失败，现有配置未修改。' }
    $configChanged = (Read-Text $CaddyFile) -cne $site
    if ($configChanged) {
        if (Test-Path -LiteralPath $CaddyFile) { Copy-Item -LiteralPath $CaddyFile -Destination "$CaddyFile.bak" -Force }
        Move-Item -LiteralPath $candidate -Destination $CaddyFile -Force
    } else {
        Remove-Item -LiteralPath $candidate -Force
    }
    $serviceChanged = Write-ServiceFiles $CaddyService (Get-CaddyServiceXml)
    $service = Get-Service -Name $CaddyService -ErrorAction SilentlyContinue
    if (-not $service -or $serviceChanged -or $service.Status -ne 'Running') {
        Restart-LeanwiseService $CaddyService
    } elseif ($configChanged) {
        $code = Invoke-Native $CaddyExe @('reload', '--config', $CaddyFile, '--adapter', 'caddyfile')
        if ($code -ne 0) { Write-Info 'reload 失败，改为重启 Caddy。'; Restart-LeanwiseService $CaddyService }
    }
    Start-Sleep -Seconds 3
    if ((Get-Service -Name $CaddyService).Status -ne 'Running') {
        Show-LogTail "$CaddyService.err.log" 40
        throw 'Caddy 未能运行。'
    }
    Write-Info 'Caddy 已运行。首次申请 HTTPS 证书可能需要 1-2 分钟。'
}

function Set-Firewall {
    $name = 'Leanwise HTTP/HTTPS'
    if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow -Profile Any | Out-Null
    }
    Write-Info 'Windows 防火墙已允许入站 TCP 80/443。腾讯云安全组也需放行 80/443。'
}

function Remove-OldReleases {
    $keep = @((Get-State 'current'), (Get-State 'previous'))
    $all = @(Get-ChildItem -LiteralPath $ReleasesDir -Directory | Sort-Object Name -Descending)
    $recent = @($all | Where-Object { $_.Name -notlike '.*' } | Select-Object -First 5 | ForEach-Object { $_.FullName })
    foreach ($dir in $all) {
        if ($keep -contains $dir.FullName -or $recent -contains $dir.FullName) { continue }
        Write-Info "清理旧版本：$($dir.Name)"
        Invoke-Native (Join-Path $env:SystemRoot 'System32\cmd.exe') @('/d', '/c', 'rd', '/s', '/q', $dir.FullName) | Out-Null
    }
}

function Invoke-Verify {
    Write-Step '验收'
    $ok = $true
    foreach ($id in @($ApiService, $CaddyService)) {
        $service = Get-Service -Name $id -ErrorAction SilentlyContinue
        $status = '未安装'
        if ($service) { $status = [string]$service.Status }
        Write-Info "服务 $($id)：$status"
        if ($status -ne 'Running') { $ok = $false }
    }
    try {
        $local = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/status' -UseBasicParsing -TimeoutSec 10
        Write-Info "本机 API：$($local.Content)"
        if (-not ($local.Content | ConvertFrom-Json).configured) { Write-Info '尚未配置 DeepSeek 密钥：执行 SetKey 步骤。' }
    } catch {
        $ok = $false
        Write-Info "本机 API 失败：$($_.Exception.Message)"
    }
    $ips = Resolve-IPv4 $Domain
    Write-Info "DNS $Domain -> $($ips -join ', ')"
    if ($ips -notcontains $ServerIp) { $ok = $false; Write-Info "域名没有解析到 $($ServerIp)：请在 DNS 添加 A 记录 www.leanwise -> $ServerIp。" }
    foreach ($path in @('/api/status', '/')) {
        try {
            $response = Invoke-WebRequest -Uri "https://$Domain$path" -UseBasicParsing -TimeoutSec 20
            Write-Info "HTTPS $($path)：HTTP $($response.StatusCode)"
        } catch {
            $ok = $false
            Write-Info "HTTPS $path 失败：$($_.Exception.Message)"
        }
    }
    if ($ok) {
        Write-Info '全部通过。请在浏览器完成一次文字解析、保存记录并刷新确认记录仍在。'
    } else {
        Write-Info '未全部通过。常见原因：DNS 未生效、腾讯云安全组未放行 80/443、域名未备案被拦截、证书仍在申请。'
        Show-LogTail "$CaddyService.err.log" 20
    }
    return $ok
}

function Invoke-Check {
    Write-Step '系统'
    $os = Get-CimInstance Win32_OperatingSystem
    Write-Info "$($os.Caption) build $($os.BuildNumber) $($os.OSArchitecture)"
    Write-Info "PowerShell $($PSVersionTable.PSVersion)；.NET Framework release $(Get-NetFrameworkRelease)（需 >= 394254）"
    Write-Info "运行身份：$([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    $drive = Get-PSDrive -Name $Root.Substring(0, 1)
    Write-Info "$($drive.Name): 可用 $([math]::Round($drive.Free / 1GB, 1)) GB（建议 >= 3 GB）"
    $existingNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($existingNode) { Write-Info "已有 Node.js：$($existingNode.Source)（不会修改，Leanwise 使用独立版本）" }
    Write-Info "curl.exe：$(Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\curl.exe'))"

    Write-Step '端口 80/443/2019/8787'
    $owners = @(Get-PortOwners @(80, 443, 2019, 8787))
    if ($owners.Count -eq 0) { Write-Info '均未被占用。' }
    foreach ($item in $owners) { Write-Info "$($item.Port)：PID $($item.Pid) $($item.Name) $($item.Path)" }
    $iis = Get-Service -Name W3SVC -ErrorAction SilentlyContinue
    if ($iis) { Write-Info "IIS (W3SVC)：$($iis.Status)" }

    Write-Step 'DNS'
    $ips = Resolve-IPv4 $Domain
    Write-Info "$Domain -> $($ips -join ', ')（应为 $ServerIp）"

    Write-Step '外网连通（部署所需）'
    $urls = @(
        "https://api.github.com/repos/$Repo",
        "https://codeload.github.com/$Repo/zip/$Branch",
        $Pinned.Node.Urls[0],
        $Pinned.Node.Urls[1],
        $Pinned.Caddy.Urls[0],
        $Pinned.WinSW.Urls[0],
        'https://registry.npmjs.org/express',
        'https://registry.npmmirror.com/express',
        'https://api.deepseek.com'
    )
    foreach ($url in $urls) { Write-Info "$(Test-Url $url)  $url" }
    Write-Host ''
    Write-Host '检查完成，没有修改服务器。'
}

function Invoke-Status {
    Write-Step '服务与版本'
    foreach ($id in @($ApiService, $CaddyService)) {
        $service = Get-Service -Name $id -ErrorAction SilentlyContinue
        $status = '未安装'
        if ($service) { $status = [string]$service.Status }
        Write-Info "$($id)：$status"
    }
    Write-Info "当前版本：$(Get-State 'current')"
    Write-Info "上一版本：$(Get-State 'previous')"
    Write-Step '端口'
    foreach ($item in @(Get-PortOwners @(80, 443, 2019, 8787))) { Write-Info "$($item.Port)：PID $($item.Pid) $($item.Name) $($item.Path)" }
    Write-Step '最近日志'
    foreach ($name in @("$ApiService.out.log", "$ApiService.err.log", "$ApiService.wrapper.log", "$CaddyService.err.log")) { Show-LogTail $name 20 }
}

function Invoke-SetKey {
    Write-Step '配置 DeepSeek 密钥'
    $key = $ApiKey.Trim()
    if ($key -notmatch '^sk-[A-Za-z0-9_-]{16,}$') { throw '密钥格式无效。请把命令中的占位符替换为完整的 DeepSeek 密钥（以 sk- 开头）。' }
    if (-not (Get-Service -Name $ApiService -ErrorAction SilentlyContinue)) { throw '请先完成 Deploy。' }
    $backup = "$EnvFile.bak"
    $lines = @()
    if (Test-Path -LiteralPath $EnvFile) {
        Copy-Item -LiteralPath $EnvFile -Destination $backup -Force
        $lines = @((Read-Text $EnvFile) -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^\s*(export\s+)?DEEPSEEK_API_KEY\s*=' })
    }
    $lines += "DEEPSEEK_API_KEY=$key"
    Write-Utf8 $EnvFile (($lines -join "`n") + "`n")
    Restart-LeanwiseService $ApiService
    if (-not (Wait-Api)) {
        if (Test-Path -LiteralPath $backup) {
            Copy-Item -LiteralPath $backup -Destination $EnvFile -Force
            Restart-LeanwiseService $ApiService
        }
        throw '服务重启失败，已恢复之前的配置。'
    }
    Write-Info '密钥已保存（不显示）。configured=true 只表示服务读到了配置，请在网页做一次真实文字解析确认密钥与余额正常。'
    Write-Info (Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/status' -UseBasicParsing -TimeoutSec 10).Content
}

function Invoke-Rollback {
    $previous = Get-State 'previous'
    if (-not $previous -or -not (Test-Path -LiteralPath (Join-Path $previous '.leanwise-built'))) { throw '没有可回滚的上一版本。' }
    Switch-ApiRelease $previous
    Write-Info '已回滚。再次执行 Rollback 会切回刚才的版本。'
}

function Invoke-Deploy {
    Assert-PortsFree
    Initialize-Layout
    Install-Tools
    $release = New-Release
    Switch-ApiRelease $release
    Set-CaddySite $release
    Set-Firewall
    # Keep the installed copy in step with the deployed revision.
    $fromRelease = Join-Path $release 'deploy\windows\leanwise.ps1'
    if (Test-Path -LiteralPath $fromRelease) { Copy-Item -LiteralPath $fromRelease -Destination (Join-Path $Root 'leanwise.ps1') -Force }
    Remove-OldReleases
    Invoke-Verify | Out-Null
    Write-Host ''
    Write-Host "部署完成：$release"
}

function Invoke-Main {
    if ($Root -notmatch '^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$') { throw 'Root 只能包含字母、数字、点、下划线和横线，不能含空格。' }
    if ($Domain -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' -or $Domain -notlike '*.*') { throw 'Domain 格式无效。' }
    if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repo 格式无效。' }
    if ($Branch -notmatch '^[A-Za-z0-9._/-]+$' -or $Branch -like '-*') { throw 'Branch 格式无效。' }
    switch ($Action) {
        'Check' { Invoke-Check; return }
        'Status' { Invoke-Status; return }
        'Verify' { if (-not (Invoke-Verify)) { exit 2 }; return }
    }
    Assert-Platform
    $mutex = New-Object Threading.Mutex($false, 'Global\LeanwiseDeploy')
    try {
        if (-not $mutex.WaitOne(0)) { throw '另一项 Leanwise 部署正在执行，请等待其完成。' }
    } catch [Threading.AbandonedMutexException] { }
    try {
        switch ($Action) {
            'Deploy' { Invoke-Deploy }
            'SetKey' { Invoke-SetKey }
            'Rollback' { Invoke-Rollback }
        }
    } finally {
        $mutex.ReleaseMutex()
    }
}

# Dot-sourcing (". .\leanwise.ps1") only loads functions, for local testing.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-Main
    } catch {
        Write-Host ''
        Write-Host "Leanwise 失败：$($_.Exception.Message)"
        exit 1
    }
}
