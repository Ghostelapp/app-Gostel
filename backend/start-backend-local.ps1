$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (!(Test-Path -LiteralPath ".\.env")) {
  Copy-Item -LiteralPath ".\.env.example" -Destination ".\.env"
  Write-Host "Created backend\.env. Fill it in, especially ADMIN_PASSWORD and JWT_SECRET, then run this script again."
  exit 1
}

if (!(Test-Path -LiteralPath ".\.venv\Scripts\python.exe")) {
  python -m venv .venv
}

$mongoOpen = Test-NetConnection -ComputerName 127.0.0.1 -Port 27017 -InformationLevel Quiet
if (-not $mongoOpen) {
  Write-Host ""
  Write-Host "MongoDB is not running on 127.0.0.1:27017."
  Write-Host "Install/start MongoDB first, then run this script again."
  Write-Host ""
  Write-Host "Fastest options:"
  Write-Host "  - Docker Desktop: docker run -d --name ghostel-mongo -p 27017:27017 mongo:7"
  Write-Host "  - MongoDB Community Server for Windows from mongodb.com"
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "Ghostel backend is starting at:"
Write-Host "  http://127.0.0.1:8000/api/"
Write-Host ""
Write-Host "Keep this window open while using the app."
Write-Host ""

.\.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
