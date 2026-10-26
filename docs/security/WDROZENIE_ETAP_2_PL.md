> Aktualizacja 24.09.2026: po decyzji o zamkniętej dystrybucji libsignal wykluczono z produktu. Powstał [rdzeń OpenMLS i opis aktualnego stanu integracji](../../crypto/ghostel-mls/README.md). Aktualna integracja klientów/API jest opisana w [instrukcji MLS](MLS_INTEGRACJA_PL.md); nie została wdrożona ani niezależnie zaudytowana. Poniższe wyniki etapu 2 pozostają historycznym zapisem.

# Ghostel — poprawki bezpieczeństwa, etap 2

Data ukończenia etapu: 24.09.2026. Stan lokalnego checkoutu, bez wdrożenia produkcyjnego. Kontynuacja audytu; nie jest certyfikatem bezpieczeństwa ani zakończeniem migracji E2EE.

## Zrealizowane zmiany

### Sesje i WebSocket — G09

Socket jest związany z konkretnym `sid`, nie tylko z użytkownikiem. Odwołanie sesji zamyka jej połączenia w bieżącym procesie, pozostawiając pozostałe urządzenia. Przed każdym zdarzeniem wychodzącym i przetworzeniem wejściowego sprawdzany jest aktualny stan sesji w bazie, jej wygaśnięcie i istnienie użytkownika. Dzięki temu worker nie ufa lokalnemu cache po odwołaniu sesji w innym procesie.

Bezczynne połączenia sprawdzane są co 5 sekund, z dodatkowym czasem zapytania/zamknięcia (timeout po 3 s); błąd bazy zatrzymuje dostarczanie danych. Nie gwarantuje to cofnięcia ramki już wysłanej lub będącej w locie w chwili revocation. Wymagane są testy wieloprocesowe z rzeczywistą bazą i monitoring obciążenia — liczba odczytów bazy wzrasta. Stare bilety bez `sid` są odrzucane; takie klienty muszą zalogować się ponownie.

Dodano limit 16 socketów na użytkownika **w jednym workerze**, 64 KiB na wiadomość i 240 zdarzeń/minutę na konto w bazie rate limit. Skrypty lokalnego Uvicorn ustawiają także `--ws-max-size 65536 --ws-max-queue 8`. Przykład usługi w `URUCHOMIENIE_NA_SERWERZE.md` również zaktualizowano; parametry działającej usługi produkcyjnej należy ustawić osobno. Limit połączeń nie jest globalnym limitem infrastruktury.

Pliki: `backend/ws_manager.py`, `backend/server.py`, `backend/tests/test_ws_security_unit.py`.

### Odbiór E2EE i weryfikacja tożsamości — G03/G04/G05

Usunięto automatyczne zaufanie do pierwszego klucza kontaktu. Nadawanie tekstu/pliku i odbiór wymagają jawnie potwierdzonego pinu. Obecność klucza w katalogu serwera nie oznacza zaufania. Nowy magazyn `verified_keys_v3` celowo nie importuje wcześniejszych automatycznych pinów; użytkownicy muszą raz ponownie zweryfikować kontakty. Klucze tożsamości i historia nie są usuwane.

Odcisk ma teraz 256 bitów skrótu SHA-512, zamiast 64. UI wyświetla cały odcisk i instruuje porównanie poza rozmową. Własny odcisk na ekranie bezpieczeństwa pochodzi z lokalnego klucza urządzenia, a nie z odpowiedzi serwera. Potwierdzenie jest oświadczeniem użytkownika o porównaniu; aplikacja nie potrafi dowieść, że użytkownik rzeczywiście przeprowadził je niezależnym kanałem.

Usunięto fallback plaintext w deszyfratorze i w pobieraniu obrazu/audio. Wiadomość bez koperty nie wyświetla treści przesłanej przez serwer. Serwerowe zdarzenia systemowe pokazują tylko ogólny komunikat o nieautentykowanym zdarzeniu; szczegóły dotychczasowych jawnych zdarzeń nie są pokazywane. Załącznik bez metadanych kryptograficznych jest odrzucany. UI nie uruchamia podglądu/odtwarzania wiadomości, której tekstowa koperta nie została poprawnie odszyfrowana. Odpowiedź endpointu reakcji również przechodzi przez deszyfrator.

**Nie naprawiono kryptograficznego replay, związania kontekstu i członkostwa, forward secrecy ani PCS istniejącego `nacl-box-v1`.** Te problemy wymagają migracji protokołu. Jawne reakcje, profile i nazwy grup nadal są na serwerze. Zmiana potwierdzonego klucza może sprawić, że wiadomości podpisane poprzednią tożsamością nie będą wyświetlane; potrzebna jest docelowa obsługa historii tożsamości i urządzeń.

### Prywatność powiadomień — G06

Wspólna polityka `push_privacy.py` stosuje listę dozwolonych pól routingu i ogólne tytuły/treści. FCM i APNs nie wysyłają rzeczywistych nazw rozmówców, grup, awatarów, tekstu wiadomości ani dowolnych pól profilu. Także ścieżki legacy Expo dla wiadomości i prostych powiadomień otrzymują zminimalizowane dane.

Identyfikatory rozmowy, wiadomości i rozmówcy oraz stan połączenia pozostają ze względu na obecnych klientów i CallKit/Android. To ograniczenie ujawnianych danych, **nie sealed sender ani pełna anonimowość**. Dostawca nadal zna token urządzenia i moment dostarczenia. Ekran zablokowanego telefonu pokazuje ogólną nazwę `ghostel.app call`; po pobraniu danych przez uwierzytelniony klient może wyświetlić dane kontaktu lokalnie. Niezbędny retest fizycznych iOS/Android z aplikacją zamkniętą i ekranem zablokowanym.

### Limity zasobów — G10

Middleware ASGI ogranicza rzeczywistą liczbę bajtów przed parsowaniem JSON/multipart, także bez Content-Length lub przy jego zaniżeniu. Domyślnie 16 MiB, konfigurowalne `MAX_REQUEST_BODY_BYTES`; limit pojedynczego zaszyfrowanego pliku pozostaje 10 MiB. Nadmiar daje 413, błędny Content-Length 400. Przechwycenie wyjątku parsowania przez endpoint nie zamienia tego w udany upload.

To limit całego żądania, nie kompletna ochrona DoS. Nadal potrzebne limity współbieżności, czasu odczytu, liczby części multipart i zasobów reverse proxy oraz aktualizacja podatnych bibliotek. Limity upstream muszą uwzględniać narzut base64; 10 MiB pliku to około 13,34 MiB w JSON.

### Kontrola typów i prototyp Signal

Naprawiono błąd typowania nawigacji połączenia przez użycie strukturalnej trasy Expo Router. Pełne `tsc --noEmit` obecnie przechodzi.

Dodano izolowany [prototyp libsignal](../../tools/signal-prototype/README.md) z oficjalnym `@signalapp/libsignal-client@0.103.0`, przypiętym lockfile i natywnym modułem. Sześć testów rzeczywistej biblioteki sprawdza wymianę prekey, dwukierunkowe wiadomości, odrzucanie replay i podmienionych podpisów/tożsamości, integralność oraz odbiór poza kolejnością. Nie jest to własna implementacja protokołu.

**Prototyp nie jest podłączony do produkcyjnej aplikacji ani serwera.** Przechowuje testowe klucze wyłącznie w pamięci i nie ma transakcyjnego magazynu. Binding Node nie działa bezpośrednio w Expo/web. Następne prace obejmują natywne adaptery Java/Swift, osobny moduł desktop, trwały szyfrowany stan, API prekeys/urządzeń i MLS. [Oficjalne README libsignal](https://github.com/signalapp/libsignal/blob/main/README.md) wskazuje brak wsparcia dla zastosowań poza Signal i możliwe zmiany API. Model dystrybucji trzeba uzgodnić z licencją pakietu AGPL-3.0-only przed publikacją integracji.

## Walidacja

Powtarzalny zestaw: `./scripts/test-security-local.sh`. Nie ładuje .env, nie łączy się z produkcją ani MongoDB i nie wysyła push. Wymaga zainstalowanych zależności frontend i prototypu. Pełny zapis: `etap2-tests.txt`.

- 38 testów backendu: MFA, WS, limity requestów, prywatność FCM/APNs oraz istniejące przejścia stanów rozmowy.
- 20 testów Node: 8 zabezpieczeń E2EE/serwera/desktop i 12 istniejących testów połączeń.
- 6 testów oficjalnego libsignal.
- TypeScript bez błędów, kontrola składni JS i `git diff --check`.

Łącznie **64 testy** w zestawie. Test oznaczony `CONFIRMED OPEN` celowo potwierdza nadal istniejący replay starego protokołu; jego przejście nie oznacza usunięcia tej podatności. Testy WS używają atrap dwóch workerów ze wspólnym stanem, nie rzeczywistego klastra. Oddzielnie sprawdzono pięć istniejących testów builderów FCM/APNs w izolowanym venv, bez ładowania conftest/.env.

## Stan ryzyka po etapie

| Znalezisko | Aktualny stan |
|---|---|
| G03 odbiór klucza/legacy plaintext | Piny wymagane, brak plaintext fallback; nadal brak pełnego protokołu uwierzytelniania kontekstu |
| G05 pierwsze zaufanie | Usunięte automatyczne TOFU; jawna weryfikacja; per-device API i członkostwo nadal otwarte |
| G06 metadane push | Zminimalizowane nazwy/treści, routing nadal jawny; profile/grupy/reakcje nadal otwarte |
| G09 revocation WS | Poprawione lokalnie i przetestowane offline; do retestu z Mongo i wieloma workerami |
| G10 limity parserów | Limit bajtów/ramek i eventów wdrożony; ochrona infrastruktury i aktualizacje nadal otwarte |
| G01/G02/G04/G07 | Pełna migracja i granice zaufania klientów pozostają otwarte |
| G11 zależności | Brak masowej aktualizacji Expo/Python w tym etapie; wyniki audytu nadal wymagają obsługi |

Nie przeprowadzono publikacji, zmiany produkcyjnych kluczy, kasowania danych ani niezależnego audytu. Bramka dla zastosowań o najwyższej poufności pozostaje niespełniona.
