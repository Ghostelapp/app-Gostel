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
frontend/desktop-dist/Ghostel-Desktop-1.4.1-Setup.exe
```

Publish the installer as a GitHub release asset named:

```text
Ghostel-Desktop-Windows-Setup.exe
```

The landing page uses the stable
`releases/latest/download/Ghostel-Desktop-Windows-Setup.exe` URL.

Until the installer is code-signed, Windows SmartScreen may show a warning on
the first launch.

## Security model

- Node.js integration is disabled in the renderer.
- Electron context isolation and sandboxing are enabled.
- The UI is served from an internal loopback-only HTTP server.
- External links open in the system browser.
- Only media and notification permissions can be requested by the local app.
