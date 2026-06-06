# Ghostel Desktop

Ghostel Desktop packages the Expo web client as a standalone Windows
application. It uses the same account and production API as Android and the
browser version.

## Development

```powershell
cd frontend
$env:EXPO_PUBLIC_BACKEND_URL="https://api.ghostel.app"
corepack yarn desktop:build:web
corepack yarn desktop
```

## Windows installer

```powershell
cd frontend
$env:EXPO_PUBLIC_BACKEND_URL="https://api.ghostel.app"
corepack yarn desktop:build
```

The installer is generated in:

```text
frontend/desktop-dist/Ghostel-Desktop-1.4.0-Setup.exe
```

To publish the latest installer on the website:

```bash
sudo mkdir -p /var/www/ghostel/downloads
sudo cp Ghostel-Desktop-1.4.0-Setup.exe \
  /var/www/ghostel/downloads/ghostel-desktop-latest.exe
sudo chmod 644 /var/www/ghostel/downloads/ghostel-desktop-latest.exe
```

Until the installer is code-signed, Windows SmartScreen may show a warning on
the first launch.

## Security model

- Node.js integration is disabled in the renderer.
- Electron context isolation and sandboxing are enabled.
- The UI is served from an internal loopback-only HTTP server.
- External links open in the system browser.
- Only media and notification permissions can be requested by the local app.
