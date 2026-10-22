# Arranca el servidor de Praxon en Windows.
# Uso:  powershell -ExecutionPolicy Bypass -File .\run.ps1 [-Token miToken] [-Port 8080] [-Mock]
#   Sin -Token usa PRAXON_TOKEN de .env; si tampoco esta, genera uno aleatorio y lo muestra.
#   -Mock arranca el servidor de protocolo minimo (mock/server.js) en vez del servidor real.
param(
    [string]$Token = "",
    [int]$Port = 8080,
    [switch]$Mock
)

Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js no esta instalado (https://nodejs.org). Hace falta la version 22.9 o superior." -ForegroundColor Red
    exit 1
}

$envHasToken = (Test-Path ".env") -and (Select-String -Path ".env" -Pattern "^\s*PRAXON_TOKEN=\S+" -Quiet)
if (-not $Token -and -not $envHasToken -and -not $env:PRAXON_TOKEN) {
    $Token = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
    Write-Host "Token generado para esta ejecucion: $Token" -ForegroundColor Green
}
if ($Token) { $env:PRAXON_TOKEN = $Token }
$env:PORT = "$Port"

if (-not (Test-Path "node_modules")) { npm install }

$rule = Get-NetFirewallRule -DisplayName "Praxon server" -ErrorAction SilentlyContinue
if (-not $rule) {
    Write-Host ""
    Write-Host "Si el movil no conecta, abre el puerto $Port (PowerShell como administrador, una sola vez):" -ForegroundColor Yellow
    Write-Host "  New-NetFirewallRule -DisplayName 'Praxon server' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private"
    Write-Host ""
}

if ($Mock) { node --env-file-if-exists=.env mock/server.js } else { node --env-file-if-exists=.env src/index.js }
