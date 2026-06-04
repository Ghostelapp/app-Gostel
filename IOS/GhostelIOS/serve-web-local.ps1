$ErrorActionPreference = "Stop"

$env:NODE_OPTIONS = "--use-system-ca"
$env:EXPO_NO_TELEMETRY = "1"
$env:EXPO_PUBLIC_BACKEND_URL = "http://127.0.0.1:8000"

Set-Location $PSScriptRoot

npx.cmd expo export --platform web --output-dir dist-local --clear --dev

Write-Host ""
Write-Host "Ghostel web is available at:"
Write-Host "  http://127.0.0.1:19006"
Write-Host ""
Write-Host "Keep this window open while using the app."
Write-Host ""

python "$PSScriptRoot\serve_static.py" --host 127.0.0.1 --port 19006 --directory "$PSScriptRoot\dist-local"
