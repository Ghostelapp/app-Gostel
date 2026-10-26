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

### Lokalne wydanie TestFlight w Xcode (24.09.2026)

Wersja wysłana do Apple: **1.4.56 (70)**, `app.ghostel`, z Firebase,
CallKit i PushKit. Osobny projekt wydania znajduje się w
`.cache/testflight-local/frontend/ios/ghostelapp.xcworkspace` względem katalogu
głównego repozytorium. `frontend/ios` nadal zawiera projekt symulatora staging.
Otwieraj plik `.xcworkspace`, a nie `.xcodeproj`.

Projekt wydania jest kopią źródeł z chwili przygotowania. Późniejsze zmiany w
`frontend` nie aktualizują tej kopii automatycznie. Zależności `node_modules`
są współdzielone lokalnie przez dowiązanie. Plik `.xcode.env.local` w kopii
ustawia produkcyjne API, wyłącza test startowy MLS i włącza konfigurację Firebase.

Do archiwizacji użyj schematu `ghostelapp`, urządzenia `Any iOS Device (arm64)`
i `Product > Archive`. W `Signing & Capabilities` wybierz zespół
`Patryk Sonecki` (`7RPT2WR98Q`) oraz automatyczne podpisywanie.
Po udanej archiwizacji w Organizer wybierz `Distribute App > TestFlight & App Store`.
Wysłanie paczki nie jest publikacją w publicznym App Store.

Archiwizacja uruchomiona lokalnie zapisuje wynik do
`.cache/Ghostel-1.4.56-68.xcarchive`, a log do `.cache/testflight-xcode-archive.txt`.
Xcode zakończył archiwizację wynikiem `ARCHIVE SUCCEEDED`. Sprawdzono identyfikator
`app.ghostel`, wersję 1.4.56 (68), platformę iPhoneOS, obecność `main.jsbundle`
oraz podpis (`codesign --verify --deep --strict`). Wysyłka do Apple jest osobnym
krokiem; jej log znajduje się w `.cache/testflight-upload.txt`.

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

Wysyłka z 24.09.2026 zakończyła się `Upload succeeded` i `EXPORT SUCCEEDED`.
Apple odrzuciło pierwotny numer 68, ponieważ na koncie była już kompilacja 69.
Xcode podczas eksportu nadało numer **70**, zachowując wersję **1.4.56**.
Archiwum źródłowe nadal ma numer 68; wysłana paczka została zachowana jako
`artifacts/testflight/Ghostel-1.4.56-70.ipa`. Log udanej wysyłki:
`.cache/testflight-upload-retry.txt`.

Apple zgłosiło ostrzeżenia o brakujących symbolach dSYM bibliotek React,
ReactNativeDependencies i Hermes. Nie zablokowały wysyłki; diagnostyka awarii
wewnątrz tych bibliotek może zawierać niepełne nazwy funkcji.

Końcowa weryfikacja App Store Connect: kompilacja **1.4.56 (70)** ma stan
`VALID` i `IN_BETA_TESTING` dla testerów wewnętrznych. Testy zewnętrzne
pozostają w stanie `READY_FOR_BETA_SUBMISSION` (bez zgłoszenia do Beta App Review).
Identyfikator kompilacji: `8dd6f037-df4c-4cb1-afff-d907f3599a81`.
Dowód publikacji i suma kontrolna IPA: `docs/security/TESTFLIGHT_RELEASE_2026-09-24.json`.

Aktualizacja 25.09.2026: **1.4.56 (71)** z poprawkami sesji audio i przywracania
rozmowy jest dostępna w TestFlight dla testerów wewnętrznych (`IN_BETA_TESTING`).
Raport: `docs/security/IOS_LOCKSCREEN_CALL_FIX_2026-09-25.md`.


### TestFlight 1.4.56 (73) — 2026-09-25

Archive 72 was renumbered to 73 during Xcode export because 72 already existed in App Store Connect. Apple confirms VALID / IN_BETA_TESTING. IPA: `artifacts/testflight/Ghostel-1.4.56-73.ipa`. This includes the native SecureStore existing-item accessibility migration and answer-stage diagnostics. See `docs/security/IOS_LOCKSCREEN_BUILD72_2026-09-25.md`. Open the updated app once while unlocked on both devices before testing repeated locked-screen calls. Physical-device regression remains pending.
