# Ghostel MLS — integracja aplikacji

Stan: 24.09.2026. OpenMLS jest podłączone do API, rozmów 1:1 i grup, ekranów weryfikacji urządzeń oraz magazynów klientów web, desktop i mobilnych. Integracja pozostaje domyślnie wyłączona (`MLS_ENABLED=false`). Nie została wdrożona na serwer produkcyjny ani niezależnie zaudytowana. Instrukcja uruchomienia i ograniczenia: [wdrożenie MLS](../../docs/security/MLS_INTEGRACJA_PL.md).

## Biblioteka i dystrybucja zamknięta

OpenMLS **0.9.0** (MIT) implementuje MLS RFC 9420 zarówno dla dwóch osób, jak i grup. To nie jest Signal Protocol: brak interoperacyjności z Signal i brak deklaracji odporności postkwantowej. Zestaw: X25519/AES-128-GCM/SHA-256/Ed25519; snapshot rdzenia: AES-256-GCM. Aktualizacja własnego klucza MLS poprzedza każdą wysyłkę aplikacyjną.

libsignal AGPL i Wire CoreCrypto GPL nie są zależnościami produktu. Historyczny `tools/signal-prototype` jest oddzielnym narzędziem oceny, pomijanym przez domyślne testy i pakowanie aplikacji.

`Cargo.lock`, `license-inventory.json` i `THIRD_PARTY_NOTICES.md` przypinają zależności i wybraną ścieżkę licencji. Zależności HPKE na **MPL-2.0** wymagają zachowania notices i dostępu do źródeł ich plików oraz ewentualnych zmian; własne odrębne pliki Ghostel mogą pozostać zamknięte. [Wyjaśnienie Mozilla, Q8 i Q11](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). Notices oraz odnośniki do źródeł trafiają do ekranu licencji aplikacji. Przy dystrybucji należy zapewnić dalszą dostępność wskazanych źródeł. Inwentarz obejmuje także narzędzia i inne platformy, więc jest szerszy od jednego artefaktu.

## Rdzeń i adapter

- Ed25519 per urządzenie, jednorazowe KeyPackages, jawne przypięcie pełnych kluczy i zakaz ich cichej podmiany.
- Identyfikator grupy związany z rozmową i wersją protokołu; pełna weryfikacja zatwierdzonego lokalnie składu.
- Welcome, commit, aktualizacja epoki, szyfrowanie i odbiór prywatnych komunikatów MLS; odrzucanie external joins i samodzielnych propozycji.
- Izolacja operacji na kopii stanu: nieudana walidacja nie zużywa klucza odbiorczego. Pending commit blokuje wysyłkę aplikacyjną do potwierdzenia.
- Stare sekrety epok nie są zachowywane. Odbiór jest uporządkowany, a odszyfrowana historia trafia do osobnego zaszyfrowanego archiwum lokalnego.
- Adapter utrwala nowy stan wraz z outbox przed wysłaniem. Retry ponawia identyczny szyfrogram, a nie operację szyfrowania ze starego stanu.
- Serwer transakcyjnie porządkuje epoki i zdarzenia; potwierdzenie obejmuje dokładnie oczekujące żądanie. Jednoczesne commity rozstrzyga CAS.
- WASM jest bundlowany lokalnie: WebWorker na web/desktop, izolowany WebView na iOS/Android. Brak CDN; mobilny dokument blokuje sieć i pliki przez CSP i ustawienia WebView.

Rdzeń ma API zmian składu, ale aplikacja świadomie obsługuje **stały skład urządzeń danej rozmowy**. Zmiana wymaga nowej rozmowy i ponownej weryfikacji. Odwołanie urządzenia zamraża jego dotychczasowe rozmowy.

Nie deklarujemy pełnego zerowania wszystkich kopii w JS, zależnościach lub alokatorze. Ochrona przed odtworzeniem całego profilu systemowego nie jest zapewniona. FS/PCS protokołu nie usuwa już odszyfrowanej historii z urządzenia ani skutków aktywnej kompromitacji klienta.

## Budowanie i testy

Wymagany Rust co najmniej 1.91; sprawdzono 1.98.1, target `wasm32-unknown-unknown` i wasm-bindgen-cli **0.2.128**. Skrypty używają `.cache/cargo`, jeśli istnieje, albo narzędzi z PATH.

```sh
./scripts/build-mls-runtime.sh
python3 scripts/check-mls-runtime.py
./scripts/test-security-local.sh
python3 scripts/test-mls-integration.py
```

Testy integracyjne wymagają Motor/PyMongo/FastAPI/Uvicorn i binarnego MongoDB w `.cache/mongodb-test/mongod`; uruchamiają wyłącznie tymczasowy replica set na loopback. Nie czytają `.env`. Pozostałe testy po pobraniu zależności są offline. Pełna lista sprawdzonych scenariuszy i różnica między eksportem bundla a testami na urządzeniach znajdują się w instrukcji wdrożenia.

Audyt biblioteki nie jest audytem wrappera ani Ghostel: [raport OpenMLS/SRLabs](https://blog.phnx.im/openmls-independent-security-audit/), [wydanie 0.9.0](https://github.com/openmls/openmls/releases/tag/openmls-v0.9.0). Testy nie stanowią formalnego dowodu bezpieczeństwa.
