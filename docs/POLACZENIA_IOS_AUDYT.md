# Audyt i poprawki połączeń iOS — 21.09.2026

Zmiany są w kodzie lokalnym. Nie zostały wdrożone na serwer ani wysłane do TestFlight.

## Naprawione przepływy

- CallKit otrzymuje UUID i uchwyty typu `generic`. Starsze identyfikatory klientów są deterministycznie zamieniane na UUID przez serwer, zachowując możliwość ponowienia żądania.
- Odbieranie w tle nie czeka na odblokowanie ekranu, by skierować aplikację do ekranu obsługującego media. Zdarzenia odebrane przed uruchomieniem JS są odtwarzane kolejno; powtórzenia nie uruchamiają ponownie odbierania.
- Samo uruchomienie sesji audio nie oznacza odebrania połączenia. Mikrofon czeka na rzeczywiste zdarzenie aktywacji CallKit. Odtwarzane są także zdarzenia aktywacji bez UUID.
- Usunięto ignorowanie systemowego rozłączenia po odblokowaniu i blokowanie przycisków odbierz/odrzuć na iOS. Zakończenie przez rozmówcę jest raportowane do CallKit bez generowania lokalnej akcji odrzucenia.
- Zatrzymanie mikrofonu i zasobów WebRTC nie czeka na diagnostykę ani HTTP. Spóźniona zgoda na mikrofon po zakończeniu rozmowy zamyka nowo utworzone ścieżki.
- Limit czasu obejmuje przygotowanie połączenia; odebranie oferty SDP nie usuwa limitu oczekiwania na faktyczne połączenie ICE.
- Rozmowy wychodzące są rejestrowane w CallKit. Wyciszenie systemowe trafia do ścieżek mikrofonu, także jeżeli nastąpiło przed ich utworzeniem. Zmiany trasy dźwięku aktualizują przycisk głośnika.
- Rozmowy głosowe domyślnie korzystają ze słuchawki. iOS nie uruchamia równolegle InCallManager jako drugiego właściciela sesji audio. Poprawka CallKeep usuwa wymuszoną aktywację przy odczycie tras i zwalnia przekierowanie na głośnik przy wyborze słuchawki.
- Usunięto odwołanie do nieistniejącego pliku dzwonka `Ringtone.caf`.
- Przeterminowany zapis połączenia jest usuwany bez rekurencji. Sprzątanie starego połączenia nie kasuje stanu innego połączenia. Powtórzony push nie zmienia zaakceptowanego połączenia z powrotem w dzwoniące.
- Token i klucze E2EE na iOS używają ochrony „po pierwszym odblokowaniu, tylko to urządzenie”, by działały po zablokowaniu ekranu. Istniejące wpisy są migrowane przy odczycie; po aktualizacji należy otworzyć aplikację przy odblokowanym telefonie. Sekrety pozostają w Keychain.
- Backend nie akceptuje nieistniejących ani wygasłych połączeń. Warunkowe aktualizacje rozstrzygają wyścig odbierz/rozłącz i odbierz/odrzuć. Kolejne odebranie nie wysyła ponownie zdarzeń, a inna sesja nie przejmuje już odebranego połączenia.
- Powiadomienia sterujące nie używają PushKit. Są wysyłane przez FCM jako ciche APNs na iOS. PushKit służy nowym połączeniom. Odbiór FCM jest rejestrowany także na iOS; „odebrano gdzie indziej” sprząta pozostałe urządzenia.

## Sprawdzenia lokalne

- 12 testów frontendowych rzeczywistych usług z zastąpionymi granicami systemu: pamięć, CallKit, sieć. W tym test zakończenia rozmowy przy nigdy niekończących się żądaniach HTTP i diagnostyki oraz oczekiwania na aktywację audio.
- 10 testów backendowych rzeczywistych funkcji API z zastąpioną bazą danych i transportem. Obejmują wyścigi stanów, uprawnienia i wybór odbiorców powiadomień.
- 3 istniejące testy struktury FCM.
- Kontrola TypeScript, generowanie projektu iOS i eksport pakietu JS iOS.
- Sprawdzenie składni wygenerowanego AppDelegate przez kompilator Swift. To nie jest pełna kompilacja natywna ani test połączenia.

Polecenia z katalogu repozytorium:

```sh
npm --prefix frontend run test:calls
python3 -m unittest discover -s backend/tests -p test_call_transitions_unit.py
frontend/node_modules/.bin/tsc --noEmit -p frontend/tsconfig.json
npm --prefix frontend run ios:prebuild
```

## Wymagane przed wydaniem

Wdrożyć zmiany backendu razem z nowym klientem. Firebase/APNs musi mieć prawidłowe poświadczenia; zwykły token APNs nie jest tokenem FCM. Powiadomienia w tle nie mają gwarantowanego czasu dostarczenia, dlatego pozostają także WebSocket i odpytywanie sygnalizacji.

Testy powyżej nie potwierdzają działania na fizycznym urządzeniu. Nie wykonano pełnej kompilacji natywnej ani testów TestFlight; lokalnie brak CocoaPods i aktywnego logowania Expo. Wygenerowany projekt jest dostępny w `frontend/ios`.

Na dwóch iPhone’ach trzeba wykonać poniższe scenariusze w obu kierunkach, również między Wi-Fi i siecią komórkową:

| Scenariusz | Oczekiwany wynik |
| --- | --- |
| Odbierz w aplikacji, w tle i na blokadzie | Obustronny dźwięk, bez wymogu odblokowania dla rozmowy |
| Uruchomienie aplikacji przez PushKit | Pojedynczy ekran systemowy, poprawne odebranie i audio |
| Odrzuć / anuluj przed odebraniem | Dzwonienie ustaje po obu stronach, prawidłowa historia |
| Odbierz i natychmiast rozłącz | Mikrofon gaśnie, druga strona kończy rozmowę |
| Rozłącz przy utracie sieci | Lokalnie natychmiast zwolnione media, brak odnowienia zakończonego połączenia |
| Brak odpowiedzi i brak połączenia ICE | Ograniczony czas oczekiwania, brak wiecznego „łączenia” |
| Wycisz w aplikacji i w CallKit | Druga strona nie słyszy mikrofonu; stan przycisków jest zgodny |
| Słuchawka, głośnik, AirPods, odłączenie Bluetooth | Poprawna trasa, brak jednostronnej ciszy; sprawdzić czujnik zbliżeniowy |
| Zmiana Wi-Fi/LTE, przerwa połączeniem GSM | Kontrolowane wznowienie audio lub jednoznaczne zakończenie |
| Dwa urządzenia tego samego konta | Tylko jedno odbiera, pozostałe przestają dzwonić |
| Drugie połączenie w trakcie pierwszego | Sprawdzić zachowanie „zajęty”; pełne kolejkowanie wielu rozmów nie było przebudowywane |
| Ponowne połączenie po każdym scenariuszu | Brak pozostawionego mikrofonu, dzwonka lub zajętej sesji audio |

Media nadal są własnością ekranu rozmowy, a nie osobnego natywnego silnika jak w Signalu. Gest zamknięcia modalu iOS jest wyłączony, aby nie usuwał mediów bez zakończenia sygnalizacji. Niezawodność przy zimnym starcie, blokadzie i przerwaniach systemowych wymaga sprawdzenia na urządzeniu.

## Materiały porównawcze

- Signal: [CallKitCallManager.swift](https://github.com/signalapp/Signal-iOS/blob/main/Signal/Calls/CallKitCallManager.swift) — UUID i systemowe akcje start/odbierz/rozłącz/wycisz.
- Signal: [CallAudioService.swift](https://github.com/signalapp/Signal-iOS/blob/main/Signal/Calls/CallAudioService.swift) — sesja audio, słuchawka/głośnik i obsługa zakończenia.
- Apple: [Making and receiving VoIP calls](https://developer.apple.com/documentation/callkit/making-and-receiving-voip-calls) — cykl życia CallKit.
