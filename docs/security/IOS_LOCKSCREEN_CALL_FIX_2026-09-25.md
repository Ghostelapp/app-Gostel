# Poprawka odbierania połączeń przy zablokowanym iPhonie

Zgłoszenie: na dwóch iPhone'ach z wersją 1.4.56 (70) odebranie rozmowy kończy
połączenie w stanie „connecting”, a chwilę później ekran rozmowy na moment wraca.
Nie odtworzono jeszcze scenariusza na dwóch fizycznych urządzeniach ani nie
pobrano diagnostyki tej konkretnej rozmowy z serwera.

## Znalezione problemy i zmiany

- `expo-audio` domyślnie wyłącza `AVAudioSession` około 100 ms po zatrzymaniu
  odtwarzacza. Zatrzymywanie ringbacku po odebraniu mogło więc wyłączyć sesję
  właśnie używaną przez CallKit/WebRTC. Odtwarzacze ringbacku i dzwonka połączeń
  na iOS korzystają teraz z `keepAudioSessionActive: true`. Android zachowuje
  poprzednie zachowanie. Zakończenie sesji połączenia pozostaje po stronie CallKit.
- Natywny `RNCallKeep.configureAudioSession` ustawiał również `setActive:TRUE`,
  mimo że WebRTC czeka na rzeczywiste `didActivateAudioSession`. Patch pozostawia
  konfigurację kategorii/trybu, a aktywację oddaje systemowi.
- Opóźnione ponowienie nawigacji, które rozpoczęło odczyt statusu przed montażem
  ekranu lub zakończeniem rozmowy, mogło wykonać `router.replace` po tym zdarzeniu.
  Ponowna kontrola stanu i rejestr zamontowanych ekranów zapobiegają zastępowaniu
  istniejącego właściciela mediów oraz otwieraniu zakończonej rozmowy.
- Ekran mediów montuje się po zakończeniu odtwarzania sesji użytkownika, aby
  jednorazowy bootstrap nie utrwalił pustego użytkownika podczas zimnego startu.

## Walidacja

`frontend/tests/calls.test.cjs`: 17 zaliczonych testów, w tym pięć nowych regresji:
przetrwanie sesji audio po zatrzymaniu ringbacku, opóźnione ponowienie nawigacji,
zakończenie rozmowy podczas zapytania o status, kolejność sesji użytkownika
względem montażu ekranu oraz idempotentny patch natywnej konfiguracji audio.

Pełny `scripts/test-security-local.sh`: 38 testów Python, 39 Node i 9 Rust;
TypeScript, weryfikacja runtime, kontrole składni i `git diff --check` zaliczone.
Log: `.cache/testflight-71-regression.txt`.

## Test odbiorczy na urządzeniach

Po instalacji nowej kompilacji na obu iPhone'ach: wykonać rozmowę w obu
kierunkach, odebrać bez odblokowania ekranu, sprawdzić dźwięk w obu kierunkach
przez co najmniej minutę, następnie zakończyć i sprawdzić, czy ekran nie wraca.
Powtórzyć po pozostawieniu aplikacji w tle oraz po zimnym uruchomieniu z PushKit.
Udane testy automatyczne nie zastępują tej weryfikacji.

## Wydanie

Kompilacja **1.4.56 (71)** została zbudowana i wysłana z Xcode. Apple potwierdziło
`VALID` oraz `IN_BETA_TESTING` dla testerów wewnętrznych. IPA:
`artifacts/testflight/Ghostel-1.4.56-71.ipa`. Test dwóch fizycznych iPhone'ów
pozostaje do wykonania; nie potwierdzono jeszcze ustąpienia zgłoszonej usterki.
