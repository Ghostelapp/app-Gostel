# Ghostel na iOS

Wersja na iPhone’a/iPada korzysta z istniejącego backendu i kont Ghostel.
Na iOS dolna nawigacja ma wysokość 49 punktów plus bezpieczny obszar
wskaźnika Home, etykiety pod ikonami i haptykę przy wyborze zakładki.
Przejścia między ekranami używają animacji iOS.

## TestFlight / App Store

W katalogu `frontend`:

```sh
npm ci
npx eas-cli login
npm run ios:build:testflight
```

Profil `ios-testflight` używa Firebase, CallKit i PushKit, identyfikatora
`app.ghostel` oraz serwera `https://api.ghostel.app`. Wymaga pliku
`GoogleService-Info.plist` dla tego identyfikatora. Numer kompilacji
jest automatycznie zwiększany. Nie używaj profilu `ios-production`
bez Firebase do testowania powiadomień.

Budowanie wymaga dostępu do projektu Expo i konta Apple Developer
z uprawnieniami do tej aplikacji. Po pomyślnym zbudowaniu:

```sh
npm run ios:submit:testflight
```

Wybierz konkretną kompilację do wysłania. Profil wskazuje istniejący rekord
App Store Connect `6781015398`. Wysłanie do TestFlight nie publikuje aplikacji
w App Store; testerów i wydanie obsługuje się w App Store Connect.

## Lokalna weryfikacja

```sh
npm run ios:prebuild
```

Generuje projekt Xcode w `frontend/ios`, bez instalacji CocoaPods.
Pełna lokalna kompilacja wymaga Xcode i CocoaPods. Projekt natywny jest
generowany z konfiguracji Expo i pluginów — zmiany utrzymuj w tych źródłach.

Oddzielny build symulatora:

```sh
npm run ios:build:simulator
```

Profil symulatora pomija Firebase. Powiadomienia i rozmowy przy zablokowanym
ekranie sprawdzaj na fizycznym iPhonie w wersji TestFlight.

## Przed wydaniem

Sprawdź na urządzeniu logowanie, wysyłanie i odbiór wiadomości, zdjęcia,
mikrofon, rozmowy przy otwartej aplikacji i zablokowanym ekranie,
powiadomienia po zamknięciu aplikacji oraz układ z klawiaturą i większym tekstem.
Backend musi mieć prawidłowo skonfigurowane FCM/APNs i VoIP push.
Uzupełnij informacje o prywatności i szyfrowaniu w App Store Connect
zgodnie z rzeczywistym działaniem aplikacji.

Dokumentacja: https://docs.expo.dev/build/setup/
