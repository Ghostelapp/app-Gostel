# Ghostel Staging — lokalne buildy i testy MLS

Wariant `staging` ma nazwę **Ghostel Staging**, identyfikator iOS/Android `app.ghostel.staging` i schemat `ghostel-staging`. Może współistnieć z wydaniem produkcyjnym. Lokalny build korzysta z osobnego cache Metro. Build wymaga zgodnych `APP_VARIANT=staging` i `EXPO_PUBLIC_APP_VARIANT=staging`; skrypt i profile EAS ustawiają obie. Konfiguracja odrzuca produkcyjne API, brak adresu, dane logowania w URL i niezabezpieczone zdalne HTTP. HTTP jest dopuszczone wyłącznie na loopback. Oddzielne identyfikatory są zgodne z [zaleceniami Expo dla wariantów aplikacji](https://docs.expo.dev/build-reference/variants/).

## Lokalny backend

Wymagania: Python 3.12, Node z zależnościami frontendu i oficjalny `mongod` w `.cache/mongodb-test/mongod` (sprawdzany wcześniej MongoDB 8.0.17). Używamy minimalnego zestawu zależności pełnego backendu, nie wszystkich narzędzi z produkcyjnego `requirements.txt`. Nie jest to odtworzenie obrazu produkcyjnego ani audyt jego zależności.

```sh
python3.12 -m venv .cache/mls-staging-venv
.cache/mls-staging-venv/bin/pip install -r scripts/requirements-mls-staging.txt
.cache/mls-staging-venv/bin/python scripts/run-mls-staging.py --smoke
# Interaktywna praca z aplikacją (Ctrl-C zatrzymuje usługi):
.cache/mls-staging-venv/bin/python scripts/run-mls-staging.py
```

Na tym komputerze venv jest już przygotowany. Launcher uruchamia pełny `backend/server.py`, skopiowany wraz z modułami Python do odizolowanego katalogu. Nie kopiuje `.env`, kluczy ani plików konfiguracyjnych Firebase/APNs. Proces dostaje jawnie zbudowane środowisko, nowy JWT secret i własne konta testowe. Produkcyjny plik `.env` nie jest ładowany. Przekazywanie zgłoszeń do produkcyjnego supportu jest wyłączone przez lokalny adres docelowy.

- API: `http://127.0.0.1:18794`, MLS włączone.
- MongoDB: wyłącznie `127.0.0.1:28794`, replica set `ghostel_staging`, baza `ghostel_mls_staging`.
- Dane i logi: `.cache/mls-staging/`; pozostają po zatrzymaniu.
- Losowe hasła: `.cache/mls-staging/credentials.json`, uprawnienia `0600`. Nie publikować tego pliku.
- Po `--smoke` istnieją konta `mls-staging-alice@example.com` i `mls-staging-bob@example.com`; hasła w polach `alice` i `bob`. Test odwołuje własne urządzenia na końcu, więc dla testu aplikacji należy utworzyć nową rozmowę i zatwierdzić jej urządzenia.

Nie otwierać portu MongoDB w sieci. To izolowany staging lokalny, nie publiczny serwer. Obecność zajętego portu lub drugiego launchera zatrzymuje start zamiast użyć obcej usługi. Testy stosują dane syntetyczne.

## iOS Simulator

```sh
./scripts/build-mls-staging-ios.sh
```

Skrypt generuje projekt, instaluje CocoaPods i buduje konfigurację Release z wbudowanym JavaScript, lokalnym podpisem dla symulatora i bez Metro. Artefakt docelowy:
`.cache/mls-staging-ios/Build/Products/Release-iphonesimulator/GhostelStaging.app`.
Istniejący projekt iOS innego wariantu nie zostanie nadpisany. SDK SQLite, WebView i SecureStore są częścią natywnego buildu. Sam eksport Expo nie sprawdza ich kompilacji.

Po zbudowaniu można uruchomić natywny autotest:

```sh
# Jednorazowo utworzyć dedykowany symulator (nazwy runtime/type dobrać z simctl list):
xcrun simctl create 'Ghostel MLS Staging' com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-5
python3 scripts/test-mls-staging-ios.py
```

Na tym komputerze dedykowany symulator już utworzono. Runner instaluje wyłącznie `app.ghostel.staging`, uruchamia automatyczny test startowy (`EXPO_PUBLIC_MLS_SELF_TEST=1` ustawiane wyłącznie przez skrypt builda symulatora), sprawdza wynik i powtarza po restarcie procesu. Test używa faktycznego WebView/WASM i magazynu SQLite/SecureStore; zapisuje tylko wynik w osobnej bazie diagnostycznej. Nie czyta kluczy. Trasa nie wykonuje testu w wariancie produkcyjnym. Nie wymaga backendu ani logowania i nie zastępuje testów pełnej rozmowy na urządzeniach. Build symulatora używa lokalnego podpisu Xcode (`CODE_SIGN_IDENTITY=-`), aby SecureStore miał poprawne uprawnienia Keychain; nie jest to podpis dystrybucyjny ani paczka dla fizycznego iPhone’a.

Przy uruchomionym lokalnym backendzie można zainstalować `.app` w Xcode Simulator, zalogować syntetyczne konta i wykonać macierz poniżej. Adres `127.0.0.1` dotyczy symulatora na tym Macu; nie nadaje się dla fizycznego telefonu.

## EAS i fizyczne urządzenia

Profile `staging` i `staging-simulator` są dodane do `frontend/eas.json`. Profil fizyczny wymaga ustawienia `EXPO_PUBLIC_BACKEND_URL` na rzeczywisty **osobny HTTPS staging** w środowisku EAS `preview`; nie ma domyślnej produkcji. Nie uruchomiono zdalnego buildu ani publikacji do sklepów.

Ponieważ repozytorium ma natywny projekt Androida z produkcyjnym identyfikatorem, hook `eas-build-pre-install` dla stagingu przenosi go poza izolowany workspace budowania. EAS generuje projekt z konfiguracji stagingowej. Hook odmawia działania poza środowiskiem EAS. Produkcyjne profile nie są zmieniane. Kolejność hooków: [dokumentacja EAS](https://docs.expo.dev/build-reference/npm-hooks/).

Aktualne profile stagingowe mają `EXPO_STAGING_NO_PUSH=1`: nie używają produkcyjnych plików Firebase, a rejestracja powiadomień FCM/Expo jest pomijana. Do testów push trzeba przygotować osobne aplikacje Firebase dla `app.ghostel.staging`, ustawić `STAGING_GOOGLE_SERVICES_ANDROID`, `STAGING_GOOGLE_SERVICES_IOS`, wyłączyć flagę i skonfigurować stagingowe APNs/FCM po stronie serwera. To osobny etap; testy MLS bez push nie potwierdzają dostarczania powiadomień ani połączeń w tle.

Na tym Macu wykryto Xcode 26.5 i symulatory iOS 26.5, ale brak działającego JDK i Android SDK. Lokalny APK wymaga ich instalacji; alternatywą jest build EAS z poprawną konfiguracją stagingu. Fizyczny iPhone wymaga odpowiedniego podpisywania/rejestracji urządzenia.

## Macierz odbioru — do wykonania na klientach

Każdy scenariusz wykonać dla iOS ↔ Android, mobile ↔ desktop oraz mobile ↔ web. Wyniki zapisywać z wersją aplikacji/OS; nie wpisywać treści, kluczy ani tokenów do publicznych logów.

| Scenariusz | Warunek zaliczenia |
| --- | --- |
| Porównanie fingerprintów i aktywacja | Obie strony zatwierdzają ten sam skład; niezweryfikowany klient nie wysyła. |
| Tekst, zdjęcie, plik, nagranie | Odbiorca odczytuje treść; backend przechowuje tylko szyfrogramy i dopuszczone metadane. |
| Odłączenie sieci po wysłaniu | Ponowienie nie tworzy drugiej wiadomości i nie cofa kluczy. |
| Zabicie aplikacji i restart | Historia i outbox są odzyskane; nowa wiadomość nadal działa. |
| Równoczesna wysyłka | Klient synchronizuje epokę po konflikcie, nie pozostaje w pending commit. |
| Dłuższa przerwa offline | Zdarzenia są odbierane po kolei bez pominięcia Welcome/commit. |
| Wylogowanie i ponowne logowanie | Tożsamość urządzenia pozostaje stała, stara sesja traci dostęp. |
| Odwołanie urządzenia | Stara rozmowa zostaje zamrożona; nowa działa po ponownej weryfikacji składu. |
| Uszkodzenie lokalnego magazynu | Aplikacja zgłasza błąd i nie zastępuje kluczy po cichu. |
| Stary klient / próba downgrade | Serwer odrzuca wiadomości legacy w rozmowie MLS. |

## Dowody automatyczne

- `node --test tests/staging-config.cjs`: izolacja wariantów, zakaz produkcyjnego API i zabezpieczenie hooka.
- `scripts/run-mls-staging.py --smoke`: pełne logowanie/sesje, kontakty, tworzenie rozmowy, MLS, restart klienta, upload/download szyfrowanego załącznika i odrzucenie starego protokołu.
- `scripts/test-mls-integration.py`: nadal osobna macierz awarii/współbieżności na efemerycznej bazie i uproszczonym routerze testowym.

Smoke test używa rzeczywistego WASM i klienta TypeScript, ale magazynu testowego w pamięci. Nie zastępuje testów SecureStore/SQLite i UI na fizycznym urządzeniu. Wynik kompilacji i testy wykonane w tej sesji są opisane w podsumowaniu pracy; sama obecność instrukcji nie oznacza zaliczenia całej macierzy.

### Wyniki z 24.09.2026

Przeszło 93 testy regresyjne/integracyjne (38 Python, 34 Node, 9 Rust, 12 integracyjnych), kontrola TypeScript oraz osobny smoke test pełnego backendu z załącznikiem. Aplikacja webowa na trasie diagnostycznej wykonała wymianę 54 000 bajtów i po przeładowaniu ponownie zwróciła `PASS`, z licznikiem trwałego stanu zwiększonym z 1 do 2. Nie przeprowadzono testów fizycznego Androida/iPhone'a ani push. Kompilacja iOS Release zakończyła się `BUILD SUCCEEDED`. Po wznowieniu pracy natywny autotest na symulatorze iOS 26.5 zakończył się `PASS`: rzeczywista wymiana MLS przez WebView/WASM (54 000 bajtów), zapis SQLite/SecureStore i odczyt po restarcie procesu. Dwa kolejne uruchomienia zwróciły `persistedRuns: 1` oraz `persistedRuns: 2`. Potwierdza to rozwiązanie wcześniejszego błędu dostępu do Keychain w paczce symulatora.

Ponownie wykonano `scripts/test-security-local.sh`: 38 testów Python, 34 testy Node i 9 testów Rust zakończyły się powodzeniem; przeszły również kontrola TypeScript, kontrola runtime MLS, kontrole składni oraz `git diff --check`. Zapis końcowego wyniku natywnego znajduje się w `mls-ios-simulator-result.json`, a log powtórzonych testów w `mls-resume-regression.txt` w tym katalogu.

**Etap lokalnego stagingu i natywnej weryfikacji iOS jest zakończony.** Nie jest to wydanie produkcyjne ani TestFlight. Testy na fizycznych urządzeniach, Androidzie, push i pełna macierz między platformami pozostają niewykonane.
