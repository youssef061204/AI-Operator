$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

# Inspect listeners without terminating processes owned by other sessions.
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(3000, 7788) })
if ($listeners.Count -gt 0) {
  foreach ($listener in $listeners) {
    Write-Warning "Port $($listener.LocalPort) is occupied by PID $($listener.OwningProcess). No process was stopped."
  }
  throw "Required ports are occupied. Use the existing stack, or stop its owning session yourself before running setup again."
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Host "Installing locked dependencies..."
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed ($LASTEXITCODE)." }

Write-Host "Building shared package..."
pnpm --filter @operator-assist/shared build
if ($LASTEXITCODE -ne 0) { throw "Shared package build failed ($LASTEXITCODE)." }

Write-Host "Starting local operator stack..."
pnpm dev
if ($LASTEXITCODE -ne 0) { throw "Development stack exited with code $LASTEXITCODE." }