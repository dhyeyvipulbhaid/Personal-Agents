# Silent per-user install, launch, and uninstall.
# /S is the silent install switch. It also writes a desktop shortcut.
# The program files must be under %LOCALAPPDATA%. The shortcut must be
# in this user's profile, not in Program Files or the public desktop.

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$bundle = Join-Path $root "apps\desktop\src-tauri\target\release\bundle\nsis"
$installer = Get-ChildItem -Path $bundle -Filter "*-setup.exe" | Select-Object -First 1
if (-not $installer) {
  throw "NSIS installer was not produced in $bundle"
}

$installDir = Join-Path $env:LOCALAPPDATA "Personal Agents"
$exe = Join-Path $installDir "personal-agents.exe"
$uninstaller = Join-Path $installDir "uninstall.exe"
$dataDir = Join-Path $env:LOCALAPPDATA "com.personalagents.desktop"
$roamingDir = Join-Path $env:APPDATA "com.personalagents.desktop"
$hkcuUninstall = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Personal Agents"
$hkcuPublisher = "HKCU:\Software\Personal Agents"
$hklmKeys = @(
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Personal Agents",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Personal Agents",
  "HKLM:\Software\Personal Agents"
)
$outsidePaths = @(
  (Join-Path $env:ProgramFiles "Personal Agents"),
  (Join-Path ${env:ProgramFiles(x86)} "Personal Agents"),
  (Join-Path $env:ProgramData "Personal Agents"),
  (Join-Path $env:PUBLIC "Desktop\Personal Agents.lnk"),
  (Join-Path $env:PUBLIC "Desktop\Personal Agents")
)
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Personal Agents.lnk"
$userShortcutPaths = @(
  $desktopShortcut,
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Personal Agents.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Personal Agents")
)

function Assert-Absent([string]$Path, [string]$Label) {
  if (Test-Path -LiteralPath $Path) {
    throw "$Label was written: $Path"
  }
}

function Assert-UnderLocalAppData([string]$Path, [string]$Label) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
  if (-not $root.EndsWith("\")) {
    $root = "$root\"
  }
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is not under %LOCALAPPDATA%: $full"
  }
}

function Stop-AppProcesses {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "personal-agents.exe" -or
    ($_.CommandLine -and (
      $_.CommandLine -like "*\Personal Agents\personal-agents.exe*" -or
      $_.CommandLine -like "*com.personalagents.desktop*"
    ))
  }
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Assert-NoListeningPorts([int[]]$ProcessIds) {
  foreach ($procId in $ProcessIds) {
    $listening = Get-NetTCPConnection -OwningProcess $procId -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
      $ports = ($listening | ForEach-Object { $_.LocalPort }) -join ", "
      throw "process $procId is listening on TCP port $ports"
    }
  }
}

Write-Host "Installer: $($installer.FullName)"
Write-Host "User: $env:USERNAME"
Write-Host "LOCALAPPDATA: $env:LOCALAPPDATA"

$manifest = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($installer.FullName))
if ($manifest -notmatch 'level="asInvoker"') {
  throw "installer does not request execution level asInvoker"
}
if ($manifest -match 'level="requireAdministrator"' -or $manifest -match 'level="highestAvailable"') {
  throw "installer requests elevation"
}

if (Test-Path -LiteralPath $installDir) {
  throw "install dir already exists: $installDir"
}

$installed = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -WorkingDirectory $env:TEMP -Wait -PassThru
if ($installed.ExitCode -ne 0) {
  throw "installer exited $($installed.ExitCode)"
}

if (-not (Test-Path -LiteralPath $exe)) {
  throw "executable missing: $exe"
}
Assert-UnderLocalAppData $exe "executable"
Assert-UnderLocalAppData $uninstaller "uninstaller"

foreach ($path in $outsidePaths) {
  Assert-Absent $path "path outside the user profile"
}

if (-not (Test-Path -LiteralPath $desktopShortcut)) {
  throw "silent install did not create a desktop shortcut for this user: $desktopShortcut"
}
$desktopFull = [System.IO.Path]::GetFullPath($desktopShortcut)
$userRoot = [System.IO.Path]::GetFullPath($env:USERPROFILE)
if (-not $userRoot.EndsWith("\")) {
  $userRoot = "$userRoot\"
}
if (-not $desktopFull.StartsWith($userRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "desktop shortcut is outside the user profile: $desktopFull"
}
foreach ($key in $hklmKeys) {
  Assert-Absent $key "HKLM key"
}

$uninstallKey = Get-ItemProperty -Path $hkcuUninstall
$location = $uninstallKey.InstallLocation.Trim().Trim('"')
Assert-UnderLocalAppData $location "registry InstallLocation"
if ($uninstallKey.DisplayName -ne "Personal Agents") {
  throw "unexpected DisplayName: $($uninstallKey.DisplayName)"
}
if (-not (Test-Path -LiteralPath $hkcuPublisher)) {
  throw "per-user publisher key missing: $hkcuPublisher"
}

$app = Start-Process -FilePath $exe -WorkingDirectory $installDir -PassThru
$deadline = (Get-Date).AddSeconds(20)
$dataReady = $false
while ((Get-Date) -lt $deadline) {
  if ($app.HasExited) {
    throw "Personal Agents exited early with code $($app.ExitCode)"
  }
  if (Test-Path -LiteralPath $dataDir) {
    $dataReady = $true
    break
  }
  Start-Sleep -Seconds 1
}
if (-not $dataReady) {
  Stop-AppProcesses
  throw "webview data was not created under $dataDir"
}
Assert-UnderLocalAppData $dataDir "webview data"

$related = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -eq $app.Id -or
  $_.ParentProcessId -eq $app.Id -or
  ($_.CommandLine -and $_.CommandLine -like "*com.personalagents.desktop*")
}
$ids = @($related | ForEach-Object { [int]$_.ProcessId })
Assert-NoListeningPorts $ids

Stop-AppProcesses
$gone = $false
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-Process -Name "personal-agents" -ErrorAction SilentlyContinue)) {
    $gone = $true
    break
  }
  Stop-AppProcesses
  Start-Sleep -Seconds 1
}
if (-not $gone) {
  throw "Personal Agents was still running before uninstall"
}

$removed = Start-Process -FilePath $uninstaller -ArgumentList "/S" -WorkingDirectory $env:TEMP -Wait -PassThru
if ($removed.ExitCode -ne 0) {
  throw "uninstaller exited $($removed.ExitCode)"
}

$leftovers = @($installDir, $exe, $dataDir, $roamingDir, $hkcuUninstall, $hkcuPublisher) + $outsidePaths + $userShortcutPaths + $hklmKeys
foreach ($path in $leftovers) {
  for ($i = 0; $i -lt 15; $i++) {
    if (-not (Test-Path -LiteralPath $path)) {
      break
    }
    Start-Sleep -Seconds 1
  }
  Assert-Absent $path "leftover"
}

Write-Host "Windows per-user install check passed"
