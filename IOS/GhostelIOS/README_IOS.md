# Ghostel iOS

Ten folder zawiera osobna wersje projektu przygotowana pod iOS.

## Co jest gotowe

- Konfiguracja Expo/EAS pod iOS.
- Bundle ID: `app.ghostel`.
- Ikony i splash z aktualnego Ghostel.
- Uprawnienia iOS dla mikrofonu, kamery, zdjec, push, VoIP/audio.
- Tymczasowe dopuszczenie HTTP/local network do testow lokalnych.

## Czego brakuje przed prawdziwym buildem

1. Wstaw prawdziwy plik Firebase iOS:

   `GoogleService-Info.plist`

   Pobierzesz go z Firebase Console dla aplikacji iOS z bundle ID:

   `app.ghostel`

2. W `eas.json` zamien:

   `https://YOUR-BACKEND-HTTPS.example.com`

   na prawdziwy adres backendu po HTTPS.

   Do testow moze byc np. ngrok:

   ```bash
   ngrok http 8000
   ```

3. Do instalacji na iPhonie potrzebne jest konto Apple Developer.

## Instalacja zaleznosci

```bash
cd /home/patryk/Pulpit/app-Gostel/IOS/GhostelIOS
yarn install
```

## Build testowy na iPhone przez EAS

```bash
npx eas login
npx eas build --platform ios --profile development
```

Albo build preview:

```bash
npx eas build --platform ios --profile preview
```

## Build produkcyjny App Store

```bash
npx eas build --platform ios --profile production
npx eas submit --platform ios --profile production
```

## Lokalny build

Lokalny build iOS wymaga macOS + Xcode:

```bash
npx expo prebuild --platform ios
npx expo run:ios --device
```

Na Linuxie nie da sie lokalnie zbudowac pliku `.ipa`.

## Wazne przed publikacja

W `app.json` jest teraz:

```json
"NSAllowsArbitraryLoads": true
```

To pomaga w lokalnych testach HTTP, ale do App Store najlepiej usunac to ustawienie i uzywac tylko backendu HTTPS.
