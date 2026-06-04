# Ghostel Frontend

Expo / React Native frontend for Ghostel.

## Linux Quick Start

From the repository root:

```bash
./frontend/setup-linux.sh
./frontend/serve-web-local.sh
```

For the Expo dev server:

```bash
./frontend/start-expo-local.sh
```

For Android:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
cd frontend/android
./gradlew assembleDebug
```

The frontend reads `EXPO_PUBLIC_BACKEND_URL` from `frontend/.env`. For phone testing, set it to the computer LAN address, for example:

```text
EXPO_PUBLIC_BACKEND_URL=http://192.168.x.x:8000
```

## Useful Commands

```bash
yarn install
yarn lint
npx expo start
npx expo export --platform web --output-dir dist-local --clear --dev
```
