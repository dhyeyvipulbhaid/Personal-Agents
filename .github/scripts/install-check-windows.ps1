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
    ($_.Name -eq "agent-host.exe" -and $_.ExecutablePath -like "$installDir\*") -or
    ($_.CommandLine -and (
      $_.CommandLine -like "*\Personal Agents\personal-agents.exe*" -or
      $_.CommandLine -like "*com.personalagents.desktop*"
    ))
  }
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Read-SharedLog([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite
  )
  try {
    $reader = New-Object System.IO.StreamReader($stream)
    $text = $reader.ReadToEnd()
    $reader.Dispose()
  } finally {
    $stream.Dispose()
  }
  if (-not $text) {
    return @()
  }
  return @($text -split "`n" | ForEach-Object { $_.TrimEnd("`r") })
}

function Get-HostStarted([string]$Path) {
  $rows = @()
  foreach ($line in @(Read-SharedLog $Path)) {
    if ($line -match '^host-started pid=(\d+) version=(\S+)$') {
      $rows += [pscustomobject]@{
        Pid = [int]$Matches[1]
        Version = $Matches[2]
      }
    }
  }
  return $rows
}

function Get-DisplayedVersion([string]$Path) {
  foreach ($line in @(Read-SharedLog $Path)) {
    if ($line -match '^displayed-host-version: (\S+)$') {
      return $Matches[1]
    }
  }
  return $null
}

function Get-ListenTcp([int]$ProcessId) {
  try {
    return @(Get-NetTCPConnection -OwningProcess $ProcessId -State Listen -ErrorAction Stop)
  } catch {
    if ($_.Exception.Message -match "No matching|No MSFT_Net") {
      return @()
    }
    throw
  }
}

function Get-ListenUdp([int]$ProcessId) {
  try {
    return @(Get-NetUDPEndpoint -OwningProcess $ProcessId -ErrorAction Stop)
  } catch {
    if ($_.Exception.Message -match "No matching|No MSFT_Net") {
      return @()
    }
    throw
  }
}

function Assert-NoListeningPorts([int[]]$ProcessIds, [string]$When) {
  $tcp = @()
  $udp = @()
  foreach ($procId in $ProcessIds) {
    $tcp += @(Get-ListenTcp $procId)
    foreach ($row in @(Get-ListenUdp $procId)) {
      # Windows uses 49152-65535 for client sockets. A listener uses a fixed port.
      if ([int]$row.LocalPort -lt 49152) {
        $udp += $row
      }
    }
  }
  if ($tcp.Count -eq 0) {
    Write-Host "TCP listen (${When}): none"
  } else {
    $ports = ($tcp | ForEach-Object { "$($_.OwningProcess):$($_.LocalPort)" }) -join ", "
    throw "listening TCP (${When}): $ports"
  }
  if ($udp.Count -eq 0) {
    Write-Host "UDP listen (${When}): none"
  } else {
    $ports = ($udp | ForEach-Object { "$($_.OwningProcess):$($_.LocalPort)" }) -join ", "
    throw "listening UDP (${When}): $ports"
  }
}

function Get-AppProcessIds([int]$AppId, [int]$HostProcessId) {
  $related = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -eq $AppId -or
    $_.ParentProcessId -eq $AppId -or
    $_.ProcessId -eq $HostProcessId -or
    ($_.CommandLine -and $_.CommandLine -like "*com.personalagents.desktop*")
  }
  return @($related | ForEach-Object { [int]$_.ProcessId } | Select-Object -Unique)
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

$hostExe = Join-Path $installDir "agent-host.exe"
if (-not (Test-Path -LiteralPath $hostExe)) {
  throw "agent host binary missing: $hostExe"
}
Assert-UnderLocalAppData $hostExe "agent host"
$hostLog = Join-Path $dataDir "host.log"
$pkg = Get-Content -Raw -LiteralPath (Join-Path $root "packages\host\package.json") | ConvertFrom-Json
$expectedVersion = [string]$pkg.version
if (-not $expectedVersion) {
  throw "host package version is empty"
}

$app = Start-Process -FilePath $exe -WorkingDirectory $installDir -PassThru
$deadline = (Get-Date).AddSeconds(20)
$dataReady = $false
while ((Get-Date) -lt $deadline) {
  if ($app.HasExited) {
    Write-Host "host log:"
    Read-SharedLog $hostLog | ForEach-Object { Write-Host $_ }
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

$readyDeadline = (Get-Date).AddSeconds(20)
$started = $null
$displayedVersion = $null
while ((Get-Date) -lt $readyDeadline) {
  if ($app.HasExited) {
    Write-Host "host log:"
    Read-SharedLog $hostLog | ForEach-Object { Write-Host $_ }
    throw "Personal Agents exited early with code $($app.ExitCode)"
  }
  $aliveIds = @()
  foreach ($proc in @(Get-Process -Name "agent-host" -ErrorAction SilentlyContinue)) {
    if (-not $proc.Path) {
      continue
    }
    $full = [System.IO.Path]::GetFullPath($proc.Path)
    if ($full.Equals([System.IO.Path]::GetFullPath($hostExe), [StringComparison]::OrdinalIgnoreCase)) {
      $aliveIds += [int]$proc.Id
    }
  }
  foreach ($line in @(Get-HostStarted $hostLog)) {
    if ($aliveIds -contains $line.Pid) {
      $started = $line
      break
    }
  }
  $displayedVersion = Get-DisplayedVersion $hostLog
  if ($started -and $displayedVersion) {
    break
  }
  Start-Sleep -Milliseconds 200
}
if (-not $started -or -not $displayedVersion) {
  Write-Host "host log:"
  Read-SharedLog $hostLog | ForEach-Object { Write-Host $_ }
  throw "agent host did not report a version"
}
if ($started.Version -ne $expectedVersion) {
  throw "host version $($started.Version) != $expectedVersion"
}
if ($displayedVersion -ne $expectedVersion) {
  throw "displayed host version $displayedVersion != $expectedVersion"
}
Write-Host "agent host version: $($started.Version)"
Write-Host "displayed host version: $displayedVersion"

$hostProc = Get-CimInstance Win32_Process -Filter "ProcessId=$($started.Pid)"
if (-not $hostProc) {
  throw "agent host process $($started.Pid) disappeared"
}
if ($hostProc.Name -ne "agent-host.exe") {
  throw "agent host process name is $($hostProc.Name)"
}
if (-not $hostProc.ExecutablePath) {
  throw "agent host executable path is empty"
}
$hostPath = [System.IO.Path]::GetFullPath($hostProc.ExecutablePath)
if (-not $hostPath.Equals([System.IO.Path]::GetFullPath($hostExe), [StringComparison]::OrdinalIgnoreCase)) {
  throw "agent host path is $hostPath"
}
if ([int]$hostProc.ParentProcessId -ne $app.Id) {
  throw "agent host parent is $($hostProc.ParentProcessId), expected $($app.Id)"
}

$ids = @(Get-AppProcessIds $app.Id ([int]$started.Pid))
Assert-NoListeningPorts $ids "before restart"

$oldProcessId = [int]$started.Pid
$watch = [System.Diagnostics.Stopwatch]::StartNew()
Stop-Process -Id $oldProcessId -Force
$back = $null
while ($watch.Elapsed.TotalSeconds -lt 3) {
  foreach ($line in @(Get-HostStarted $hostLog)) {
    if ($line.Pid -eq $oldProcessId) {
      continue
    }
    $proc = Get-Process -Id $line.Pid -ErrorAction SilentlyContinue
    if ($proc -and -not $proc.HasExited) {
      $back = $line
      break
    }
  }
  if ($back) {
    break
  }
  Start-Sleep -Milliseconds 100
}
$watch.Stop()
$seconds = [math]::Round($watch.Elapsed.TotalSeconds, 3)
if (-not $back) {
  Write-Host "host log:"
  Read-SharedLog $hostLog | ForEach-Object { Write-Host $_ }
  throw "agent host was not back within 3 seconds (waited $seconds s)"
}
$app.Refresh()
if ($app.HasExited) {
  throw "Personal Agents exited when the agent host was stopped"
}
if ($back.Version -ne $expectedVersion) {
  throw "restarted host version $($back.Version) != $expectedVersion"
}
Write-Host "host restart seconds: $seconds"
Write-Host "restarted host pid: $($back.Pid)"

$ids = @(Get-AppProcessIds $app.Id ([int]$back.Pid))
Assert-NoListeningPorts $ids "after restart"

Stop-AppProcesses
$gone = $false
for ($i = 0; $i -lt 20; $i++) {
  $appStill = @(Get-Process -Name "personal-agents" -ErrorAction SilentlyContinue).Count
  $hostStill = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "agent-host.exe" -and $_.ExecutablePath -like "$installDir\*"
  }).Count
  if ($appStill -eq 0 -and $hostStill -eq 0) {
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
