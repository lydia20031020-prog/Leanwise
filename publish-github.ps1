param(
    [string]$CommitMessage = 'Build Leanwise web and mini program demo'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
$portableGit = Join-Path $env:USERPROFILE '.codex\tools\leanwise-git\runtime\cmd\git.exe'
if ($gitCommand) { $taskGit = $gitCommand.Source }
elseif (Test-Path -LiteralPath $portableGit) { $taskGit = $portableGit }
else { throw 'Install Git for Windows from https://git-scm.com/download/win and retry.' }

function Invoke-TaskGit {
    & $taskGit @args
    if ($LASTEXITCODE -ne 0) { throw "Git command failed: $($args[0])" }
}

if (-not (Test-Path -LiteralPath '.git')) { Invoke-TaskGit init --initial-branch=main }
$origin = & $taskGit remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) { Invoke-TaskGit remote add origin 'https://github.com/lydia20031020-prog/Leanwise.git' }
elseif ($origin -ne 'https://github.com/lydia20031020-prog/Leanwise.git') { throw 'Origin is different; inspect git remote -v before publishing.' }
if ((& $taskGit branch --show-current) -ne 'main') { throw 'Publish from the main branch.' }
Invoke-TaskGit config user.name 'lydia20031020-prog'
Invoke-TaskGit config user.email 'lydia20031020-prog@users.noreply.github.com'
Invoke-TaskGit config core.autocrlf false
Invoke-TaskGit check-ignore .env private.wx5971d92eb86b0234.key node_modules dist
Invoke-TaskGit add --all
$trackedFiles = @(& $taskGit ls-files)
foreach ($file in $trackedFiles) {
    if ($file -match '(^|/)(node_modules|dist|data)/|(^|/)\.env($|\.)' -and $file -ne '.env.example') {
        throw "Unexpected sensitive/generated file staged: $file"
    }
    if ($file -match '(?i)\.key$|\.secret$|project\.private\.config\.json$') { throw "Private file staged: $file" }
    $absoluteFile = Join-Path $PSScriptRoot $file
    if (Test-Path -LiteralPath $absoluteFile -PathType Leaf) {
        $contents = [IO.File]::ReadAllText($absoluteFile)
        if ($contents -match 'sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----') {
            throw "Credential pattern found; review before publishing: $file"
        }
    }
}
Invoke-TaskGit diff --cached --stat
& $taskGit diff --cached --quiet
if ($LASTEXITCODE -eq 1) { Invoke-TaskGit commit -m $CommitMessage }
elseif ($LASTEXITCODE -ne 0) { throw 'Unable to inspect staged changes.' }

$ghCommand = Get-Command gh.exe -ErrorAction SilentlyContinue
$portableGh = Join-Path $env:USERPROFILE '.codex\tools\leanwise-gh\runtime\bin\gh.exe'
if ($ghCommand) { $taskGh = $ghCommand.Source }
elseif (Test-Path -LiteralPath $portableGh) { $taskGh = $portableGh }
if ($taskGh) {
    & $taskGh auth status --hostname github.com
    if ($LASTEXITCODE -ne 0) {
        & $taskGh auth login --hostname github.com --git-protocol https --web --skip-ssh-key
        if ($LASTEXITCODE -ne 0) { throw 'Complete GitHub login and retry.' }
    }
    $env:PATH = (Split-Path -Parent $taskGit) + ';' + $env:PATH
    & $taskGh auth setup-git --hostname github.com
    if ($LASTEXITCODE -ne 0) { throw 'GitHub credential setup failed.' }
}
Invoke-TaskGit push --set-upstream origin main
Write-Output 'Published: https://github.com/lydia20031020-prog/Leanwise'
