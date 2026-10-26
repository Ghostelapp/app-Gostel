# Integracja MLS w Ghostel — 24.09.2026

Implementacja jest połączona z aplikacją; produkcja nie została zmieniona. Wybrano OpenMLS 0.9.0 zamiast bibliotek Signal/Wire wymagających GPL/AGPL, zgodnie z decyzją o zamkniętej dystrybucji. MLS obsługuje rozmowy 1:1 i grupowe. To nie jest implementacja Signal Protocol.

## Co działa

- Rejestracja urządzenia z dowodem posiadania klucza Ed25519 związanym z sesją logowania; kontrola odwołanej sesji także wewnątrz transakcji.
- Publikacja i uzupełnianie KeyPackages, jednorazowe transakcyjne wydawanie oraz idempotentne ponawianie żądań.
- Wyświetlanie pełnych fingerprintów, jawne zatwierdzenie urządzeń i lokalny zakaz zmiany przypiętego klucza lub protokołu.
- Inicjowanie rozmowy przez jej twórcę, Welcome, rotacja epok, wymiana wiadomości i odzyskanie po restarcie/utracie odpowiedzi.
- Szyfrowanie treści, nazw i parametrów załączników, kluczy plików, reakcji i zdarzeń usunięcia. Załączniki mają osobne losowe klucze; serwer przechowuje zaszyfrowane pliki i szyfrogramy MLS.
- Serwerowa kolejność zdarzeń, kontrola epoki i sekwencji, transakcyjny outbox klienta, odrzucanie starego protokołu po aktywacji.
- Powiadomienia push bez treści wiadomości; WebSocket sygnalizuje potrzebę pobrania zdarzeń.
- Odwołanie urządzenia oraz utworzenie nowej rozmowy dla zmienionego składu.

Serwer nadal zna konta, skład rozmów, urządzenia, czasy, rozmiary i relacje między załącznikami a rozmowami. MLS nie zapewnia anonimowości metadanych transportowych.

## Magazyny klientów

| Platforma | Magazyn |
| --- | --- |
| iOS / Android | SQLite WAL z pełnym synchronizowaniem, dwa zaszyfrowane sloty; losowy klucz i kotwica aktualnego slotu/hash w SecureStore. Stan/outbox utrwalany przed wysłaniem. |
| Desktop Electron | AES-256-GCM, klucz opakowany przez systemowe `safeStorage`, atomowy zapis/fsync i kontrola rewizji. Linux `basic_text` jest odrzucany. IPC dopuszcza tylko główną ramkę własnego okna/origin. |
| Przeglądarka | IndexedDB, AES-GCM z nieeksportowalnym CryptoKey, transakcje o trwałości `strict`, wyłączna blokada `navigator.locks` między kartami. Wymaga bezpiecznego kontekstu. |

Brak klucza, uszkodzona kotwica lub błąd zapisu blokują operację. Klient nie zastępuje po cichu tożsamości. Wylogowanie nie usuwa historii i kluczy. Reinstalacja/wyczyszczenie danych może bezpowrotnie odebrać dostęp do lokalnej historii. Nie ma jeszcze szyfrowanej kopii zapasowej ani migracji historii między urządzeniami.

Przeglądarka ufa dostarczanemu kodowi strony; XSS lub przejęty origin mogą użyć klucza mimo jego nieeksportowalności. Desktop/web nie mają sprzętowego licznika zapobiegającego odtworzeniu całego starego profilu. Kotwica mobilna chroni przed cofnięciem samej bazy, nie przed wszystkimi rodzajami pełnego rollbacku systemu. Historia jest lokalnie odszyfrowywalna i nie znika dzięki rotacji kluczy transportowych.

## Uruchomienie

1. Zbudować runtime przez `./scripts/build-mls-runtime.sh`, sprawdzić `python3 scripts/check-mls-runtime.py` i dołączyć notices/licencje generowane w aplikacji. Źródła i przypięte zależności opisuje [README rdzenia](../../crypto/ghostel-mls/README.md).
2. Przygotować MongoDB jako replica set lub sharded cluster. Standalone nie obsługuje wymaganych transakcji. Backend przy `MLS_ENABLED=true` sprawdza topologię i wymagane indeksy; błąd zatrzymuje start.
3. Najpierw wdrożyć aktualny backend na wszystkie instancje z wyłączonym MLS. Wycofać stare procesy przed włączeniem flagi. Nie mieszać starej wersji API z włączonym MLS — stary worker nie zna zakazu wiadomości legacy.
4. Zbudować i dostarczyć aktualne klienty. **iOS/Android wymagają nowego binarnego wydania z Expo SQLite 16.0.10**; aktualizacja samego JavaScript przez OTA nie wystarczy. Desktop wymaga nowego preload/main i systemowego magazynu kluczy.
5. Po testach na środowisku staging, urządzeniach i niezależnym audycie ustawić `MLS_ENABLED=true` globalnie i zrestartować aktualne procesy. Nie zmieniano tu produkcyjnego `.env`.
6. Każdy uczestnik otwiera ekran bezpieczeństwa rozmowy, rejestruje swoje urządzenie i porównuje pełne fingerprinty niezależnym kanałem. Każdy zatwierdza dokładnie ten sam skład. Twórca wybiera aktywację MLS. Serwerowy katalog sam nie stanowi podstawy zaufania.
7. W istniejącej rozmowie najpierw wyłączyć stary timer znikających wiadomości. Po aktywacji archiwum NaCl pozostaje oznaczone jako starsze i tylko do odczytu. Nowe wiadomości przechodzą wyłącznie przez MLS. Przed przejściem trzeba zapewnić aktualne wersje aplikacji wszystkim uczestnikom.

Wyłączenie flagi po aktywacji zatrzymuje dostarczanie MLS; nie jest migracją do starego szyfrowania. Nie cofać protokołu istniejących rozmów ani danych klientów. Do zmiany składu użyć nowej rozmowy z ponowną weryfikacją. Odwołanie jednego urządzenia zamraża wszystkie rozmowy, do których należało — dotyczy także pozostałych uczestników.

## Zakres i ograniczenia wydania

Skład urządzeń jest stały. Nie ma automatycznego dodawania urządzeń, przenoszenia historii, key transparency ani pełnej polityki dynamicznych ról administratorów. Wiadomości jednorazowe i timery znikania nie są obsługiwane w MLS; ich użycie nie uruchamia fallbacku. Potwierdzenia odczytu/liczniki nieprzeczytanych nie mają jeszcze kompletnego protokołu MLS. Szyfrowanie połączeń głosowych, profili i backupów nie zostało zastąpione przez ten moduł.

Stare wiadomości nie uzyskują wstecznie FS/PCS. Zestaw MLS nie jest postkwantowy. Archiwum lokalne rośnie wraz z historią; limity stanu rdzenia, IPC i magazynu mogą zablokować dalszą pracę przy bardzo dużej historii. Nie wdrożono bezpiecznego stronicowania/eksportu archiwum. Brak niezależnego audytu tej integracji, fuzzingu całej powierzchni i testów długotrwałych na rzeczywistych urządzeniach: nie przedstawiać tego wydania jako zatwierdzonego do produkcji.

## Weryfikacja

- `./scripts/test-security-local.sh`: 38 testów Python, 34 Node, 9 Rust, TypeScript, składnia JS, zgodność źródeł/WASM i whitespace.
- `python3 scripts/test-mls-integration.py`: 12 testów, prawdziwy WASM + klient TypeScript + FastAPI + tymczasowy MongoDB replica set. Wymiana/restart, utrata potwierdzenia, błąd trwałego zapisu, brak weryfikacji, downgrade, współbieżne commity, grupa/reakcje, odwołanie urządzenia, blokada legacy, jednorazowe KeyPackages, dowód posiadania klucza, autoryzacja usunięcia i odwołana sesja.
- Testy magazynu mobilnego symulują awarie przed/po zapisaniu kotwicy i rollback SQLite. SecureStore jest atrapą — nie jest to test rzeczywistego Keychain/Keystore.
- `node scripts/prepare-mls-browser-test.cjs` generuje test przeglądarki pod `.cache/mls-browser-test`; można serwować wyłącznie na loopback przez `python3 -m http.server 18793 --bind 127.0.0.1 --directory .cache/mls-browser-test`. Sprawdzono realny IndexedDB/CryptoKey oraz 20 aktualizacji w dwóch ramkach.
- `swift scripts/test-mls-webkit.swift "$PWD/.cache/mls-webkit-runtime.html"` sprawdza aktualny bundlowany runtime w macOS WKWebView: RNG, CSP, Welcome, wymianę i dzielony transport dużych komunikatów. Fixture generuje powyższy skrypt.
- Eksport Expo zakończył się poprawnie dla web, iOS i Android (`EXPO_NO_DOTENV=1`, bez ładowania lokalnego `.env`). Bundlowanie nie zastępuje podpisanego buildu aplikacji, testów fizycznych iOS/Android ani pełnego testu UI. Expo zgłosiło brak lokalnego `google-services.json`; pełne wydanie Android wymaga właściwej konfiguracji Firebase projektu.

Wszystkie testy używają syntetycznych danych; nie ładowały produkcyjnego `.env` i nie korzystały z bazy użytkowników.

Następny etap: [lokalny staging i buildy urządzeniowe](MLS_STAGING_PL.md).
