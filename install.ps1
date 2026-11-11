# Unsigned user installer. It downloads or copies one bundle, checks SHA-256,
# unpacks under the user profile, and changes only the user Path.
param(
  [string]$File,
  [string]$Url,
  [string]$Sha
)

$ErrorActionPreference = "Stop"

if (-not $Sha) {
  throw "pass -Sha"
}

$homeDir = if ($env:PA_HOME) { $env:PA_HOME } else { $env:LOCALAPPDATA }
$work = Join-Path $homeDir "Personal Agents"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$dest = Join-Path $work "bundle.bin"

if ($Url) {
  Invoke-WebRequest -Uri $Url -OutFile $dest
} elseif ($File) {
  Copy-Item $File $dest -Force
} else {
  throw "pass -Url or -File"
}

$actual = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLowerInvariant()
$expected = $Sha.ToLowerInvariant()
if ($actual -ne $expected) {
  Remove-Item $dest -Force
  throw "sha256 mismatch"
}

$installed = Join-Path $work "personal-agents.exe"
Copy-Item $dest $installed -Force

if ($env:PA_HOME) {
  Set-Content -Path (Join-Path $homeDir "user-path.txt") -Value $work
} else {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) {
    $userPath = ""
  }
  $parts = $userPath.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)
  if ($parts -notcontains $work) {
    $next = if ($userPath) { "$userPath;$work" } else { $work }
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
  }
}

$ollama = $env:PA_OLLAMA_STATUS
if (-not $ollama) {
  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $ollama = "stopped"
  } else {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 1 | Out-Null
      $ollama = "running"
    } catch {
      $ollama = "stopped"
    }
  }
}

if ($ollama -ne "running") {
  Write-Output "Ollama is not running. Install it from https://ollama.com/download"
}
