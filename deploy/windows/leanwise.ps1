<#
Leanwise 网站部署：Windows Server + 腾讯云「命令执行」（PowerShell，SYSTEM 或管理员）。

  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Leanwise\leanwise.ps1 -Action Check
  ... -Action Deploy              首次安装与后续更新（同一命令）
  ... -Action SetKey -ApiKey sk-  配置 DeepSeek 密钥
  ... -Action Verify | Status | Rollback

布局：C:\Leanwise\{tools,releases,config,data,logs,service,state}
服务：LeanwiseApi（Node，仅监听 127.0.0.1:8790）。
HTTPS：
  - 80/443 已由现有 Caddy 提供时：只在其 Caddyfile 末尾追加带 BEGIN/END 标记的本站块并平滑 reload，
    不停止、不重启、不修改其他网站；运行配置与文件不一致时停止，不做修改。
  - 80/443 空闲时：安装独立的 LeanwiseCaddy 服务。
密钥只在 config\leanwise.env（仅 SYSTEM 与管理员可读），不进入仓库或网页。
#>
param(
    [ValidateSet('Check', 'Deploy', 'SetKey', 'Verify', 'Status', 'Rollback')]
    [string]$Action = 'Check',
    [string]$ApiKey = '',
    [string]$Root = 'C:\Leanwise',
    [string]$Domain = 'www.leanwise.lydiaowo.com',
    [string]$ServerIp = '43.143.208.73',
    [int]$ApiPort = 8790,
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
$SharedAdminUrl = 'http://127.0.0.1:2019/config/'
$ManagedPattern = '(?ms)^# BEGIN leanwise\b.*?^# END leanwise[^\r\n]*'

# Compares two JSON files after sorting object keys; exit 0 when equal.
$JsonEqualJs = @'
const fs = require('fs');
const sort = (v) => Array.isArray(v) ? v.map(sort) : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o, k) => { o[k] = sort(v[k]); return o; }, {}) : v;
const load = (f) => { const t = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').trim(); return sort(t ? JSON.parse(t) : null); };
process.exit(JSON.stringify(load(process.argv[2])) === JSON.stringify(load(process.argv[3])) ? 0 : 1);
'@

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

# Captures raw stdout bytes to a file (no console code-page conversion).
function Invoke-ToFile([string]$FilePath, [string[]]$Arguments, [string]$OutFile) {
    $quoted = @($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
    $errFile = "$OutFile.err"
    $process = Start-Process -FilePath $FilePath -ArgumentList $quoted -NoNewWindow -Wait -PassThru -RedirectStandardOutput $OutFile -RedirectStandardError $errFile
    if ($process.ExitCode -ne 0 -and (Test-Path -LiteralPath $errFile)) {
        Get-Content -LiteralPath $errFile -Encoding UTF8 | Select-Object -Last 15 | ForEach-Object { Write-Host "   $_" }
    }
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    return $process.ExitCode
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

function Test-OwnTool([string]$Path) {
    return [bool]($Path -and $Path.StartsWith("$ToolsDir\", [StringComparison]::OrdinalIgnoreCase))
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

# Reads how an existing Caddy was launched. Without --config, Caddy loads
# ./Caddyfile; the caller confirms the guess by comparing with the live config.
function Get-CaddyLaunch([string]$CommandLine, [string]$ExePath) {
    $tokens = @([regex]::Matches($CommandLine, '"([^"]*)"|(\S+)') | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } })
    $config = ''
    $adapter = ''
    for ($i = 1; $i -lt $tokens.Count; $i++) {
        $token = $tokens[$i]
        if (($token -eq '--config' -or $token -eq '-c') -and $i + 1 -lt $tokens.Count) { $i++; $config = $tokens[$i] }
        elseif ($token -like '--config=*') { $config = $token.Substring(9) }
        elseif ($token -eq '--adapter' -and $i + 1 -lt $tokens.Count) { $i++; $adapter = $tokens[$i] }
        elseif ($token -like '--adapter=*') { $adapter = $token.Substring(10) }
    }
    if (-not $config) { $config = 'Caddyfile' }
    if (-not [IO.Path]::IsPathRooted($config)) { $config = Join-Path (Split-Path -Parent $ExePath) $config }
    $problem = ''
    if ($adapter -and $adapter -ne 'caddyfile') { $problem = "现有 Caddy 使用 $adapter 格式配置，脚本只支持 Caddyfile。" }
    elseif (-not $adapter -and $config -match '\.json$') { $problem = '现有 Caddy 使用 JSON 配置，脚本只支持 Caddyfile。' }
    elseif (-not (Test-Path -LiteralPath $config -PathType Leaf)) { $problem = "找不到现有 Caddy 的配置文件 $config。" }
    return [pscustomobject]@{ Config = $config; Problem = $problem }
}

# own: 80/443 free (or our LeanwiseCaddy); shared: an existing caddy.exe owns them.
function Get-ProxyPlan([int[]]$WebPorts = @(80, 443)) {
    $owners = @(Get-PortOwners $WebPorts)
    $foreign = @($owners | Where-Object { -not (Test-OwnTool $_.Path) })
    if ($foreign.Count -eq 0) {
        $admin = @(Get-PortOwners @(2019) | Where-Object { -not (Test-OwnTool $_.Path) })
        if ($admin.Count -gt 0) { return [pscustomobject]@{ Mode = 'blocked'; Reason = "端口 2019 被 PID $($admin[0].Pid) $($admin[0].Name) 占用。" } }
        return [pscustomobject]@{ Mode = 'own' }
    }
    $pids = @($foreign | Select-Object -ExpandProperty Pid -Unique)
    $process = $null
    if ($pids.Count -eq 1 -and $owners.Count -eq $foreign.Count) { $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($pids[0])" }
    if (-not $process -or $process.Name -ne 'caddy.exe') {
        $list = ($owners | ForEach-Object { "$($_.Port)=PID $($_.Pid) $($_.Name) $($_.Path)" }) -join '; '
        return [pscustomobject]@{ Mode = 'blocked'; Reason = "80/443 被非 Caddy 程序占用：$list。PID 4 通常是 IIS/HTTP.sys。" }
    }
    $launch = Get-CaddyLaunch ([string]$process.CommandLine) ([string]$process.ExecutablePath)
    return [pscustomobject]@{ Mode = 'shared'; Pid = $pids[0]; CaddyExe = [string]$process.ExecutablePath; ConfigPath = $launch.Config; Problem = $launch.Problem }
}

function Show-Plan($Plan) {
    switch ($Plan.Mode) {
        'own' { Write-Info '80/443 空闲：将安装独立的 LeanwiseCaddy 服务。' }
        'shared' {
            Write-Info "80/443 由现有 Caddy 提供：PID $($Plan.Pid) $($Plan.CaddyExe)"
            Write-Info "配置文件：$($Plan.ConfigPath)"
            if ($Plan.Problem) { Write-Info "无法自动加入：$($Plan.Problem)" }
            else { Write-Info '部署时只在该文件末尾追加本站独立站点块并平滑 reload；不停止、不重启 Caddy，不修改其他网站。' }
        }
        'blocked' { Write-Info "无法部署：$($Plan.Reason)" }
    }
}

function Assert-Plan($Plan) {
    if ($Plan.Mode -eq 'blocked') { throw "$($Plan.Reason) 为避免影响现有网站，未做任何修改。" }
    if ($Plan.Mode -eq 'shared' -and $Plan.Problem) { throw "$($Plan.Problem) 未做任何修改。" }
}

function Assert-ApiPortFree {
    $conflicts = @(Get-PortOwners @($ApiPort) | Where-Object { -not (Test-OwnTool $_.Path) })
    if ($conflicts.Count -gt 0) {
        throw "端口 $ApiPort 被 PID $($conflicts[0].Pid) $($conflicts[0].Name) 占用。可加参数 -ApiPort 换一个空闲端口。未做任何修改。"
    }
}

function Initialize-Layout {
    foreach ($dir in @($Root, $ToolsDir, $CacheDir, $ReleasesDir, $ConfigDir, $DataDir, $LogDir, $ServiceDir, $StateDir)) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    }
    # config holds the API key and Caddyfile backups; data holds TLS keys. SYSTEM + Administrators only.
    foreach ($dir in @($ConfigDir, $DataDir)) {
        $code = Invoke-Native (Join-Path $env:SystemRoot 'System32\icacls.exe') @($dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q')
        if ($code -ne 0) { throw "无法设置目录权限：$dir" }
    }
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        Write-Utf8 $EnvFile "DEEPSEEK_API_KEY=`nDEEPSEEK_BASE_URL=https://api.deepseek.com`nDEEPSEEK_MODEL=deepseek-flash`n"
    }
}

function Install-Tools([bool]$WithCaddy) {
    Write-Step '准备运行环境（固定版本，SHA-256 校验）'
    if (-not (Test-Path -LiteralPath $NodeExe)) {
        $zip = Get-VerifiedFile $Pinned.Node "node-$($Pinned.Node.Version)-win-x64.zip"
        $temp = Join-Path $ToolsDir '.node-extract'
        Expand-Zip $zip $temp
        if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
        Move-Item -LiteralPath (Join-Path $temp "node-$($Pinned.Node.Version)-win-x64") -Destination $NodeDir
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
    Write-Info "Node.js $(& $NodeExe --version)（独立安装，不影响服务器已有的 Node.js）"
    if ($WithCaddy) {
        if (-not (Test-Path -LiteralPath $CaddyExe)) {
            $zip = Get-VerifiedFile $Pinned.Caddy "caddy_$($Pinned.Caddy.Version)_windows_amd64.zip"
            Expand-Zip $zip $CaddyDir
        }
        Write-Info "Caddy $(& $CaddyExe version)"
    }
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
    foreach ($file in @('package.json', 'package-lock.json', 'server\index.js')) {
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
  <description>Leanwise Node.js API and web frontend on 127.0.0.1:$ApiPort</description>
  <executable>$NodeExe</executable>
  <arguments>--env-file=$EnvFile $entry</arguments>
  <workingdirectory>$ReleaseDir</workingdirectory>
  <env name="NODE_ENV" value="production"/>
  <env name="HOST" value="127.0.0.1"/>
  <env name="PORT" value="$ApiPort"/>
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
  <description>HTTPS reverse proxy for $Domain to 127.0.0.1:$ApiPort</description>
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

function Get-SiteBlock([string]$NewLine) {
    return (@(
        "# BEGIN leanwise (managed by $Root\leanwise.ps1; other sites unchanged)",
        "$Domain {",
        "`tencode gzip",
        "`treverse_proxy 127.0.0.1:$ApiPort",
        "`theader {",
        "`t`tX-Content-Type-Options nosniff",
        "`t`tReferrer-Policy strict-origin-when-cross-origin",
        "`t`tPermissions-Policy `"camera=(self), microphone=()`"",
        "`t}",
        '}',
        '# END leanwise'
    ) -join $NewLine)
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
    if ($Id -eq $ApiService) { Wait-PortFree $ApiPort }
    Start-Service -Name $Id
}

function Get-LocalApiUrl { return "http://127.0.0.1:$ApiPort/api/status" }

function Test-LocalApi {
    try {
        return ((Invoke-WebRequest -Uri (Get-LocalApiUrl) -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200)
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
    Write-Step "切换 API 服务（127.0.0.1:$ApiPort）"
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

# Compares the running config of the existing Caddy with its Caddyfile.
# Only when they are identical is a reload from the file safe for other sites.
function Test-SharedCaddy($Plan) {
    $live = Join-Path $ConfigDir 'caddy-live.json'
    $fromFile = Join-Path $ConfigDir 'caddy-file.json'
    $compare = Join-Path $StateDir 'json-equal.js'
    try {
        try {
            Invoke-WebRequest -Uri $SharedAdminUrl -UseBasicParsing -TimeoutSec 10 -OutFile $live
        } catch { throw "无法读取现有 Caddy 的运行配置（$SharedAdminUrl）：$($_.Exception.Message)。未做任何修改。" }
        $code = Invoke-ToFile $Plan.CaddyExe @('adapt', '--config', $Plan.ConfigPath, '--adapter', 'caddyfile') $fromFile
        if ($code -ne 0) { throw "现有 Caddyfile 无法解析：$($Plan.ConfigPath)。未做任何修改。" }
        Write-Utf8 $compare $JsonEqualJs
        $inSync = (Invoke-Native $NodeExe @($compare, $live, $fromFile)) -eq 0
        $hasDomain = ([IO.File]::ReadAllText($live)).Contains('"' + $Domain + '"')
        return [pscustomobject]@{ InSync = $inSync; HasDomain = $hasDomain }
    } finally {
        Remove-Item -LiteralPath $live, $fromFile -Force -ErrorAction SilentlyContinue
    }
}

function Assert-SharedCaddyInSync($Plan) {
    $state = Test-SharedCaddy $Plan
    if (-not $state.InSync) {
        throw "运行中的 Caddy 配置与 $($Plan.ConfigPath) 不一致（可能用了环境变量、--resume 或通过 API 改过）。直接 reload 可能影响其他网站，因此未做任何修改。"
    }
    return $state
}

function Set-SharedCaddySite($Plan) {
    Write-Step "在现有 Caddy 中加入本站（$($Plan.ConfigPath)）"
    $state = Assert-SharedCaddyInSync $Plan
    # Latin-1 maps every byte to one char, so the original bytes (any encoding,
    # BOM, line endings) are preserved exactly; only ASCII is appended.
    $latin1 = [Text.Encoding]::GetEncoding(28591)
    $originalBytes = [IO.File]::ReadAllBytes($Plan.ConfigPath)
    $text = $latin1.GetString($originalBytes)
    $newLine = "`n"
    if ($text.Contains("`r`n")) { $newLine = "`r`n" }
    $block = Get-SiteBlock $newLine
    $regex = New-Object Text.RegularExpressions.Regex($ManagedPattern)
    if ($regex.IsMatch($text)) {
        $updated = $regex.Replace($text, $block.Replace('$', '$$'), 1)
    } else {
        if ($state.HasDomain) { throw "现有 Caddy 已配置 $Domain（不在 Leanwise 管理段内）。请先确认那段配置的用途；未做任何修改。" }
        $updated = $text
        if ($updated.Length -gt 0 -and -not $updated.EndsWith("`n")) { $updated += $newLine }
        $updated += $newLine + $block + $newLine
    }
    if ($updated -ceq $text) { Write-Info '本站配置已存在且无变化，未修改 Caddy。'; return }

    # Validate next to the original so relative imports resolve the same way.
    $candidate = Join-Path (Split-Path -Parent $Plan.ConfigPath) ('.leanwise-candidate-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.caddyfile')
    try {
        [IO.File]::WriteAllBytes($candidate, $latin1.GetBytes($updated))
        $code = Invoke-Native $Plan.CaddyExe @('validate', '--config', $candidate, '--adapter', 'caddyfile')
        if ($code -ne 0) { throw '加入本站后的配置校验失败，现有 Caddy 配置未修改。' }
    } finally {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
    }
    $backupDir = Join-Path $ConfigDir 'caddy-backups'
    if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
    $backup = Join-Path $backupDir ('Caddyfile-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
    [IO.File]::WriteAllBytes($backup, $originalBytes)
    [IO.File]::WriteAllBytes($Plan.ConfigPath, $latin1.GetBytes($updated))
    $code = Invoke-Native $Plan.CaddyExe @('reload', '--config', $Plan.ConfigPath, '--adapter', 'caddyfile')
    if ($code -ne 0) {
        [IO.File]::WriteAllBytes($Plan.ConfigPath, $originalBytes)
        throw "Caddy reload 失败，已恢复原 Caddyfile；运行中的配置未改变。备份：$backup"
    }
    Write-Info "已加入本站并平滑 reload，Caddy 未重启，其他网站配置未改。原文件备份：$backup"
    if (-not (Test-SharedCaddy $Plan).InSync) { Write-Info '提示：reload 后运行配置与文件仍不一致，请运行 Status 查看。' }
}

function Set-OwnCaddySite {
    Write-Step '配置 HTTPS（独立 LeanwiseCaddy 服务）'
    $env:XDG_DATA_HOME = $DataDir
    $env:XDG_CONFIG_HOME = $DataDir
    $site = (Get-SiteBlock "`n") + "`n"
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
    $name = 'Leanwise HTTP/HTTPS'
    if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow -Profile Any | Out-Null
    }
    Write-Info 'Caddy 已运行，Windows 防火墙已允许 80/443。首次申请 HTTPS 证书可能需要 1-2 分钟。'
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
    $ids = @($ApiService)
    if (Get-Service -Name $CaddyService -ErrorAction SilentlyContinue) { $ids += $CaddyService }
    foreach ($id in $ids) {
        $service = Get-Service -Name $id -ErrorAction SilentlyContinue
        $status = '未安装'
        if ($service) { $status = [string]$service.Status }
        Write-Info "服务 $($id)：$status"
        if ($status -ne 'Running') { $ok = $false }
    }
    try {
        $local = Invoke-WebRequest -Uri (Get-LocalApiUrl) -UseBasicParsing -TimeoutSec 10
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
        Write-Info '未全部通过。常见原因：证书仍在申请（等 1-2 分钟再 Verify）、DNS 未生效、域名未备案被拦截。'
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

    Write-Step "端口 80/443/2019/$ApiPort"
    $owners = @(Get-PortOwners @(80, 443, 2019, $ApiPort))
    if ($owners.Count -eq 0) { Write-Info '均未被占用。' }
    foreach ($item in $owners) { Write-Info "$($item.Port)：PID $($item.Pid) $($item.Name) $($item.Path)" }
    $apiConflict = @($owners | Where-Object { $_.Port -eq $ApiPort -and -not (Test-OwnTool $_.Path) })
    if ($apiConflict.Count -gt 0) { Write-Info "端口 $ApiPort 已被占用，部署时需加参数 -ApiPort 换一个空闲端口。" }

    Write-Step 'HTTPS 接入方式'
    Show-Plan (Get-ProxyPlan)

    Write-Step 'DNS'
    $ips = Resolve-IPv4 $Domain
    Write-Info "$Domain -> $($ips -join ', ')（应为 $ServerIp）"

    Write-Step '外网连通（部署所需）'
    $urls = @(
        "https://api.github.com/repos/$Repo",
        "https://codeload.github.com/$Repo/zip/$Branch",
        $Pinned.Node.Urls[0],
        $Pinned.Node.Urls[1],
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
        if ($service) { Write-Info "$($id)：$($service.Status)" }
    }
    Write-Info "当前版本：$(Get-State 'current')"
    Write-Info "上一版本：$(Get-State 'previous')"
    Write-Step 'HTTPS 接入方式'
    Show-Plan (Get-ProxyPlan)
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
    Write-Info (Invoke-WebRequest -Uri (Get-LocalApiUrl) -UseBasicParsing -TimeoutSec 10).Content
}

function Invoke-Rollback {
    $previous = Get-State 'previous'
    if (-not $previous -or -not (Test-Path -LiteralPath (Join-Path $previous '.leanwise-built'))) { throw '没有可回滚的上一版本。' }
    Switch-ApiRelease $previous
    Write-Info '已回滚。再次执行 Rollback 会切回刚才的版本。'
}

function Invoke-Deploy {
    Write-Step '检查端口与现有网站'
    $plan = Get-ProxyPlan
    Show-Plan $plan
    Assert-Plan $plan
    Assert-ApiPortFree
    Initialize-Layout
    Install-Tools ($plan.Mode -eq 'own')
    if ($plan.Mode -eq 'shared') {
        Assert-SharedCaddyInSync $plan | Out-Null
        Write-Info '现有 Caddy 运行配置与文件一致，可以安全追加。'
    }
    $release = New-Release
    Switch-ApiRelease $release
    if ($plan.Mode -eq 'shared') { Set-SharedCaddySite $plan } else { Set-OwnCaddySite }
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
    if ($ApiPort -lt 1024 -or $ApiPort -gt 65535 -or $ApiPort -eq 2019) { throw 'ApiPort 必须在 1024-65535 之间且不能是 2019。' }
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
