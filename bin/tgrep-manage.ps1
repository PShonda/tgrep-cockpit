<#
.SYNOPSIS
  tgrep-manage.ps1 - Multi-project Trigram Index & tgrep serve Controller for Windows

.DESCRIPTION
  Manages tgrep background servers and trigram indexes across projects.
  Cross-platform companion to tgrep-manage.sh for Windows PowerShell.

.EXAMPLE
  .\bin\tgrep-manage.ps1 list
  .\bin\tgrep-manage.ps1 start my-project
  .\bin\tgrep-manage.ps1 stop my-project
  .\bin\tgrep-manage.ps1 index my-project
  .\bin\tgrep-manage.ps1 status my-project
#>

param (
    [Parameter(Position=0, Mandatory=$false)]
    [ValidateSet("list", "index", "start", "stop", "restart", "status")]
    [string]$Action = "list",

    [Parameter(Position=1, Mandatory=$false)]
    [string]$Target = "."
)

$ConfigFile = Join-Path $PSScriptRoot "..\config.json"
$rawDirs = if ($env:SOURCE_DIRS) {
    $env:SOURCE_DIRS
} elseif ($env:SOURCE_DIR) {
    $env:SOURCE_DIR
} elseif (Test-Path $ConfigFile) {
    try {
        $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        $cfg.workspaces -join ","
    } catch {
        (Resolve-Path "$PSScriptRoot\..\..").Path
    }
} else {
    (Resolve-Path "$PSScriptRoot\..\..").Path
}

$Workspaces = @($rawDirs -split "[,;]" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" -and (Test-Path $_) })
if ($Workspaces.Count -eq 0) {
    $Workspaces = @((Resolve-Path "$PSScriptRoot\..\..").Path)
}

function Resolve-ProjectPath([string]$path) {
    if ([System.IO.Path]::IsPathRooted($path)) {
        return $path
    }
    foreach ($ws in $Workspaces) {
        $combined = Join-Path $ws $path
        if (Test-Path $combined) {
            return (Resolve-Path $combined).Path
        }
    }
    return (Resolve-Path (Join-Path (Get-Location) $path)).Path
}

function Get-RunningServer([string]$projectPath) {
    $serveJson = Join-Path $projectPath ".tgrep\serve.json"
    if (Test-Path $serveJson) {
        try {
            $json = Get-Content $serveJson -Raw | ConvertFrom-Json
            if ($json.pid) {
                $process = Get-Process -Id $json.pid -ErrorAction SilentlyContinue
                if ($process) {
                    return $json
                } else {
                    # Stale file cleanup
                    Remove-Item $serveJson -Force -ErrorAction SilentlyContinue
                    Remove-Item (Join-Path $projectPath ".tgrep\serve.lock") -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {
            # ignore parse error
        }
    }
    return $null
}

function Show-ProjectList {
    Write-Host "==========================================================================================" -ForegroundColor Cyan
    "{0,-25} | {1,-12} | {2,-18} | {3,-10}" -f "PROJECT", "INDEXED", "SERVER STATUS", "PORT/PID"
    Write-Host "==========================================================================================" -ForegroundColor Cyan

    foreach ($ws in $Workspaces) {
        if ($Workspaces.Count -gt 1) {
            Write-Host "--- Workspace: $ws ---" -ForegroundColor DarkGray
        }
        $directories = Get-ChildItem -Path $ws -Directory -ErrorAction SilentlyContinue
        foreach ($dir in $directories) {
            $name = $dir.Name
            if ($name.StartsWith(".")) { continue }
            
            $tgrepDir = Join-Path $dir.FullName ".tgrep"
            $indexed = if (Test-Path $tgrepDir) { "Yes" } else { "No" }
            $sstatus = "Stopped"
            $detail = "-"

            if ($indexed -eq "Yes") {
                $serverInfo = Get-RunningServer $dir.FullName
                if ($serverInfo) {
                    $sstatus = "Running"
                    $detail = ":{0} (PID:{1})" -f $serverInfo.port, $serverInfo.pid
                }
            }

            "{0,-25} | {1,-12} | {2,-18} | {3,-10}" -f $name, $indexed, $sstatus, $detail
        }
    }
    Write-Host "==========================================================================================" -ForegroundColor Cyan
}

function Invoke-Index([string]$projectPath) {
    $path = Resolve-ProjectPath $projectPath
    if (-not (Test-Path $path)) {
        Write-Error "Directory not found: $path"
        exit 1
    }
    Write-Host "==> Building trigram index for: $path" -ForegroundColor Green
    Push-Location $path
    try {
        tgrep index .
    } finally {
        Pop-Location
    }
}

function Start-Server([string]$projectPath) {
    $path = Resolve-ProjectPath $projectPath
    if (-not (Test-Path $path)) {
        Write-Error "Directory not found: $path"
        exit 1
    }

    $existing = Get-RunningServer $path
    if ($existing) {
        Write-Host "Server is already running for $path (PID: $($existing.pid))" -ForegroundColor Yellow
        return
    }

    $tgrepDir = Join-Path $path ".tgrep"
    if (-not (Test-Path $tgrepDir)) {
        Write-Host "==> No index found. Building index first..." -ForegroundColor Yellow
        Invoke-Index $path
    }

    Write-Host "==> Starting tgrep serve for $path..." -ForegroundColor Green
    New-Item -ItemType Directory -Path $tgrepDir -Force | Out-Null
    Remove-Item (Join-Path $tgrepDir "serve.json") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $tgrepDir "serve.lock") -Force -ErrorAction SilentlyContinue

    $logFile = Join-Path $tgrepDir "serve.log"
    $proc = Start-Process -FilePath "tgrep" -ArgumentList "serve ." -WorkingDirectory $path -RedirectStandardOutput $logFile -RedirectStandardError $logFile -WindowStyle Hidden -PassThru

    # Wait for serve.json
    $maxWait = 30
    $count = 0
    while ($count -lt $maxWait) {
        $serverInfo = Get-RunningServer $path
        if ($serverInfo) {
            Write-Host "✓ Server successfully started!" -ForegroundColor Green
            Write-Host "  Project : $path"
            Write-Host "  PID     : $($serverInfo.pid)"
            Write-Host "  Port    : $($serverInfo.port)"
            return
        }
        Start-Sleep -Milliseconds 100
        $count++
    }

    Write-Warning "Server started (PID: $($proc.Id)) but serve.json was not ready immediately. Check $logFile"
}

function Stop-Server([string]$projectPath) {
    $path = Resolve-ProjectPath $projectPath
    if (-not (Test-Path $path)) {
        Write-Error "Directory not found: $path"
        exit 1
    }

    $serverInfo = Get-RunningServer $path
    if ($serverInfo) {
        Write-Host "==> Stopping tgrep serve for $path (PID: $($serverInfo.pid))..." -ForegroundColor Yellow
        Stop-Process -Id $serverInfo.pid -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $path ".tgrep\serve.json") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $path ".tgrep\serve.lock") -Force -ErrorAction SilentlyContinue
        Write-Host "✓ Stopped." -ForegroundColor Green
    } else {
        Write-Host "No running server detected for $path." -ForegroundColor Gray
        Remove-Item (Join-Path $path ".tgrep\serve.json") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $path ".tgrep\serve.lock") -Force -ErrorAction SilentlyContinue
    }
}

function Show-Status([string]$projectPath) {
    $path = Resolve-ProjectPath $projectPath
    if (-not (Test-Path $path)) {
        Write-Error "Directory not found: $path"
        exit 1
    }
    Push-Location $path
    try {
        tgrep status .
    } finally {
        Pop-Location
    }
}

switch ($Action) {
    "list"    { Show-ProjectList }
    "index"   { Invoke-Index $Target }
    "start"   { Start-Server $Target }
    "stop"    { Stop-Server $Target }
    "restart" { Stop-Server $Target; Start-Sleep -Milliseconds 500; Start-Server $Target }
    "status"  { Show-Status $Target }
    default   { Show-ProjectList }
}
