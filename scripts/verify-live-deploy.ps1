# Prüft, ob eine Orange-Bar-Instanz (Standard: wallet.mintlylab.com) dem erwarteten Stand nahekommt.
param(
  [string]$Base = 'https://wallet.mintlylab.com'
)

$ErrorActionPreference = 'Stop'
$expectSw = 'orange-bar-v9'

function Get-RemoteText($path) {
  return (Invoke-WebRequest -Uri ($Base.TrimEnd('/') + $path) -UseBasicParsing).Content
}

Write-Host "Orange-Bar Live-Check: $Base`n"

try {
  $health = Get-RemoteText '/api/health' | ConvertFrom-Json
  Write-Host "API /health: ok=$($health.ok) version=$($health.version) rpId=$($health.rpId)"
} catch {
  Write-Host "API /health: FEHLER - $_" -ForegroundColor Red
}

$sw = Get-RemoteText '/sw.js'
if ($sw -match "CACHE\s*=\s*'([^']+)'") {
  $cache = $Matches[1]
  $okSw = $cache -eq $expectSw
  Write-Host "Service Worker CACHE: $cache $(if ($okSw) { '[OK]' } else { "[erwartet: $expectSw]" })"
} else {
  Write-Host 'Service Worker CACHE: nicht gefunden' -ForegroundColor Red
}

$app = Get-RemoteText '/app.js'
$checks = @{
  'collectionHint'  = 'Wallet/NFT-API-Anbindung (neuer Stand)'
  'creature-row'    = 'Life-Forms-Sektion'
  'nft-list-root'   = 'NFT-Container-Layout'
}
foreach ($needle in $checks.Keys) {
  $hit = $app.Contains($needle)
  Write-Host "app.js '$needle': $(if ($hit) { 'ja' } else { 'NEIN' }) - $($checks[$needle])"
}

$css = Get-RemoteText '/style.css'
$cssOk = $css.Contains('.creature-chip')
Write-Host "style.css .creature-chip: $(if ($cssOk) { 'ja [OK]' } else { 'NEIN (riesige NFT-Bilder möglich)' })"

Write-Host "`nWenn viele NEIN: auf dem Server git pull + Prozess-Neustart, dann Handy-Cache leeren."