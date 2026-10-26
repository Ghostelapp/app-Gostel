> Aktualizacja 24.09.2026: dokument opisuje stan audytowany przed integracją. Późniejsze zmiany MLS i ich ograniczenia opisuje [aktualna instrukcja](MLS_INTEGRACJA_PL.md).

# Audyt bezpieczeństwa Ghostel — 23.09.2026

> Aktualizacja: wykonano kolejny etap poprawek. Bieżący stan, zmiany zachowania i wyniki testów opisuje [Wdrożenie — etap 2](WDROZENIE_ETAP_2_PL.md). Poniższy raport zachowuje wyniki pierwotnego audytu; statusy i numery linii odnoszą się do tamtego etapu.

## Executive Summary

**Wynik: aplikacja nie spełnia wymagania odporności na pełne przejęcie infrastruktury ani wymagań nowoczesnego protokołu E2EE. Nie rekomenduję dopuszczenia jej do zastosowań o deklarowanym najwyższym poziomie poufności.**

To audyt kodu i wybranych zachowań offline, nie certyfikat ani niezależny pełny pentest. Punkt odniesienia: commit `b7fdc70ca7751748b86ea2894ea808892fd5cbc7` oraz zastany katalog roboczy. `GhostelAPPweb/` był nieśledzony przed rozpoczęciem i nie został zmieniony. Znaleziska opisują stan początkowy i jawnie oznaczają lokalne poprawki.

W uczciwej ścieżce klient szyfruje tekst i pliki przed wysłaniem. Nie znaleziono wysyłania prywatnego klucza do API w analizowanych ścieżkach. **Nie oznacza to bezpieczeństwa wobec aktywnie złośliwego serwera**: własny protokół, TOFU, nieautentykowane członkostwo i dystrybucja web łamią mocniejsze założenia. Statyczne klucze nie zapewniają forward secrecy ani post-compromise security. Profile, grupy i reakcje nie są w pełni E2EE.

Wdrożono w checkout: ochronę 2FA przed resetem aktywnego składnika, limity prób i warunki atomowe; sprawdzanie przypiętego klucza nadawcy podczas deszyfrowania; ograniczenie ścieżek serwera statycznego; allowlistę zewnętrznych URL desktopa; minimalną długość JWT_SECRET. **Nie wdrożono Signal/MLS, nie zmieniono produkcji, nie przeprowadzono migracji danych ani kluczy.** Taka migracja wymaga osobnej integracji, wyboru utrzymywanej biblioteki i audytu; przedstawienie obecnych poprawek jako jej ukończenia byłoby nieprawdziwe.

## Zakres audytu

Przejrzano główny FastAPI/MongoDB backend, auth/2FA/sesje, klucze, wiadomości/pliki/grupy, push, WS i sygnalizację, Expo/React Native crypto/storage/PIN/eksport, konfiguracje Android/Electron, serwer Node i artefakty wdrożenia. Portal `GhostelAPPweb` sprawdzono wstępnie (auth_utils, część endpointów i klient upstream); nie stanowi on w pełni zaudytowanego drugiego produktu.

Wykonano przegląd statyczny, model zagrożeń, testy zachowania rzeczywistych funkcji offline z atrapami magazynu/API, skany lockfile npm i ograniczony skan sekretów śledzonych plików. Testy AST izolują handlery od importu konfiguracji i Mongo — nie dowodzą poprawności rzeczywistej bazy ani wdrożenia. Nie uruchamiano istniejących testów integracyjnych mogących wskazywać produkcję przez .env.

Nie wykonano pentestu produkcji, MITM na urządzeniach, fuzzingu sieciowego, analizy binariów, testu root/jailbreak, audytu uprawnień chmury ani pełnego przeglądu historii Git. Brak dowodu kontroli oznacza „niezweryfikowane”, nie automatycznie „podatne”. Nie można zagwarantować znalezienia wszystkich błędów.

Do pełnego audytu potrzebne: staging z danymi syntetycznymi i kontami o różnych rolach, urządzenia Android/iOS i podpisane buildy, konfiguracja proxy/TLS/ASGI/Mongo/firewalla, dowody szyfrowania i retencji backupów oraz prób restore, konfiguracja CI i uprawnień/review, polityka kluczy podpisujących, SBOM, konfiguracja logów/APNs/FCM/TURN, wszystkie wersje klientów i formalny opis protokołu.

## Model zagrożeń

Aktywa: treści i ich autentyczność, klucze, lista kontaktów, członkostwo, dane sesji, IP i czas komunikacji, pochodzenie aktualizacji. Granice: urządzenie ↔ OS; JS ↔ magazyn; klient ↔ API/katalog kluczy; backend ↔ baza; push/TURN; build/CDN ↔ klient.

| Napastnik | Ocena obecnego rozwiązania |
|---|---|
| Pasywny odczyt bazy | Teksty/bloby z uczciwego klienta zaszyfrowane; profile, reakcje i graf relacji jawne |
| Aktywne przejęcie API | TOFU, członkostwo, replay i pierwsza dystrybucja kluczy pozostają problemem |
| Przejęcie hostingu web | Możliwa podmiana programu kradnącego klucze; nie rozwiązuje tego sam algorytm E2EE |
| Kradzież sesji | Zmiana klucza konta, operacje konta; stary WS może działać po revocation |
| Kradzież bieżącego klucza | Możliwe odszyfrowanie zachowanej historii — brak FS |
| Malware na odblokowanym urządzeniu | Plaintext może zostać przejęty; E2EE nie chroni całkowicie przejętego endpointu |
| MITM sieci bez przejęcia TLS | Standardowy TLS jest barierą; pinning i rzeczywista konfiguracja certyfikatów niezweryfikowane |
| Złośliwy członek rozmowy | Może zapisać/udostępnić otrzymane treści; „jednorazowe” media nie gwarantują niemożności kopiowania |

## Opis architektury bezpieczeństwa

Expo (Android/iOS/web) i Electron web export komunikują się z FastAPI/MongoDB przez bearer JWT i WS. Serwer przechowuje jeden klucz publiczny na konto. Klient generuje 32-bajtowy secretKey przez expo-crypto i X25519 przez TweetNaCl. Wiadomość ma osobną kopertę nacl.box dla każdego członka, w tym nadawcy; plik ma losowy klucz nacl.secretbox opakowany per członek. Backend wymusza obecność kopert i uprawnienia do rozmowy, a pliki przyjmuje jako octet-stream/.ghostel. Sam suffix/format nie jest kryptograficznym dowodem zaszyfrowania — gwarancja musi pochodzić od zaufanego klienta.

Mobilne klucze/tokeny trafiają do SecureStore; web/desktop do AsyncStorage. iOS używa AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, czyli umożliwia działanie po pierwszym odblokowaniu również przy późniejszej blokadzie. To świadomy kompromis dostępności VoIP, nie ochrona odczytu wymagająca biometrii za każdym razem.

Mocne istniejące elementy: CSPRNG i losowe 24-bajtowe nonce, uwierzytelnione szyfrowanie NaCl, losowy osobny klucz pliku, brak plaintext fallback przy wysyłaniu tekstu w API, kontrole członkostwa i właściciela uploadu, bcrypt, rate limit logowania, ewidencja/revocation HTTP sesji, jednorazowe bilety WS ważne 60 s, SecureStore mobile, Android allowBackup=false/usesCleartextTraffic=false, izolacja i sandbox Electron. Nie znaleziono podstaw do nazywania tych istniejących kontroli nieobecnymi.

## Ocena kryptografii

NaCl box używa X25519/XSalsa20-Poly1305, secretbox XSalsa20-Poly1305. Są to znane prymitywy uwierzytelnionego szyfrowania; problemem nie jest automatycznie wybór XSalsa20, lecz własna kompozycja protokołu bez FS/PCS, uzgodnienia sesji, autentykacji kontekstu i członkostwa. Nie stwierdzono X3DH/PQXDH, Double Ratchet, MLS, podpisanych prekeys ani jawnej separacji kluczy dla profili/backupów. Istniejący fingerprint SHA-512 jest skracany do 8 bajtów; nie zastępuje standardowych safety numbers.

Specyfikacja [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) opisuje aktualizację kluczy i obejmuje rozszerzenia postkwantowe; [PQXDH](https://signal.org/docs/specifications/pqxdh/) dotyczy inicjalnego uzgodnienia. Dla grup podstawą jest [MLS RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html). Nie należy ręcznie doklejać Ed25519/HKDF do istniejącego formatu: używać dokładnego zestawu algorytmów wybranej biblioteki i jej specyfikacji, także jeśli jej podpisy nie są osobnym API Ed25519.

Forward secrecy dotyczy usuniętych kluczy protokołu, nie historii celowo zachowanej w lokalnej bazie. Przywrócenie bezpieczeństwa wymaga ustania kontroli napastnika nad urządzeniem. Szyfrowany backup kluczy historycznych może osłabić te gwarancje i musi być osobno modelowany.

## Lista podatności

### G01 — Przejęcie hostingu klienta web umożliwia kradzież kluczy

**Poziom ryzyka:** Critical. **Status:** Otwarte — ograniczenie architektury.

**Opis:** Klient web pobiera wykonywalny JavaScript od operatora. Kod ma dostęp do długoterminowych kluczy i plaintextu. Pełne przejęcie infrastruktury dostarczającej klienta pozwala podmienić program przy następnym ładowaniu.

**Wpływ:** Kradzież kluczy i odczyt historii oraz przyszłych wiadomości aktywnego użytkownika.

**Warunki wykorzystania:** Kontrola nad originem, CDN, publikacją lub service workerem; użytkownik uruchamia zmodyfikowany klient. Sam pasywny zrzut bazy nie wystarcza.

**Dowód lub obserwacja:** `frontend/src/e2ee.ts:155` (await AsyncStorage.setItem(key, raw)); frontend/public/sw.js; server.js.

**Rekomendacja naprawy:** Wyznaczyć granicę zaufania: podpisany klient natywny z niezależnie chronionym kanałem wydań. Nie deklarować odporności web na przejęcie dostawcy kodu. CSP/SRI ograniczają część ataków, nie zastępują tej granicy.

**Priorytet wdrożenia:** P0 — przed deklarowaniem odporności na pełne przejęcie serwera.

**Test potwierdzający naprawę:** Na odizolowanej kopii hostingu podmienić bundle; podpisany klient musi odrzucić nieautoryzowaną aktualizację. Udokumentować model zagrożeń web.

### G02 — Statyczny własny protokół bez forward secrecy i PCS

**Poziom ryzyka:** High. **Status:** Otwarte.

**Opis:** Każda wiadomość jest szyfrowana nacl.box stałą parą kluczy użytkowników, także do nadawcy. Brak prekeys, ratchet, epok i usuwania zużytych kluczy wiadomości. Grupy to osobny szyfrogram dla każdego konta.

**Wpływ:** Jeden wykradziony klucz prywatny pozwala odczytać dostępne stare szyfrogramy do tego klucza; protokół sam nie odzyskuje bezpieczeństwa.

**Warunki wykorzystania:** Uzyskanie prywatnego klucza oraz szyfrogramów; samo przejęcie bazy bez kluczy nie odszyfrowuje uczciwie wysłanych wiadomości.

**Dowód lub obserwacja:** `frontend/src/e2ee.ts:411` (export async function encryptTextForConversation); test CONFIRMED OPEN w tests/security-audit.cjs.

**Rekomendacja naprawy:** Zastąpić protokół utrzymywaną implementacją Signal dla 1:1 i sprawdzonym MLS dla grup. Nie implementować ratchet samodzielnie. Zwykła rotacja klucza konta nie naprawia protokołu.

**Priorytet wdrożenia:** P0 — blokada produkcji o deklarowanym poziomie poufności.

**Test potwierdzający naprawę:** Wektory biblioteki, utrata pakietów, restart i rollback stanu; snapshot bieżących kluczy nie odszyfrowuje usuniętych dawnych kluczy wiadomości; po uczciwym ratchet napastnik traci dostęp.

### G03 — Odbiór ufał kluczowi nadawcy z niezaufanej koperty

**Poziom ryzyka:** High. **Status:** Częściowo naprawione lokalnie.

**Opis:** Deszyfrator używał sender_public_key dostarczonego z wiadomością bez porównania z lokalnym pinem. Teraz odrzuca rozbieżność dla przypiętego kontaktu oraz własnych wiadomości, także przy plikach. Pierwszy kontakt nadal opiera się na TOFU. Ponadto legacy ścieżka `if (!message.e2ee) return message` umożliwia serwerowi podanie nieszyfrowanej wiadomości; kontrola pinów nie zamyka tej ścieżki downgrade. Pełne usunięcie fallbacku wymaga rozdzielenia archiwum/systemowych zdarzeń od nowych wiadomości.

**Wpływ:** Aktywnie złośliwy serwer mógł dostarczyć wiadomość napastnika jako wiadomość zaufanego kontaktu.

**Warunki wykorzystania:** Kontrola serwera odpowiedzi/transportu aplikacyjnego i znajomość publicznego klucza odbiorcy; nie trzeba znać klucza kontaktu.

**Dowód lub obserwacja:** `frontend/src/e2ee.ts:507` (async function matchesPinnedSender); przed poprawką test z kluczem Mallory zwrócił „forged”, po poprawce zwraca e2ee_decrypted=false.

**Rekomendacja naprawy:** Zachować kontrolę pinów, wymusić niezależną weryfikację nowych kontaktów i urządzeń oraz audytowaną autentykację całego transkryptu. Zmiana klucza może uczynić stare wiadomości niedostępnymi; potrzebny model wersji tożsamości.

**Priorytet wdrożenia:** P0.

**Test potwierdzający naprawę:** Fałszywy klucz kontaktu oraz podmieniona koperta pliku muszą zostać odrzucone; zatwierdzona migracja tożsamości musi mieć jawny, audytowalny przebieg.

### G04 — Replay i brak kryptograficznego związania kontekstu

**Poziom ryzyka:** High. **Status:** Otwarte.

**Opis:** Szyfrowany jest tekst, ale nie identyfikator rozmowy, wiadomości, rodzaj, reply_to ani epoka członkostwa. Odbiorca nie utrzymuje kryptograficznego stanu antyreplay.

**Wpływ:** Złośliwy serwer może powtarzać wiadomości i przenosić szyfrogramy między kontekstami tych samych uczestników. Losowy nonce nie jest ochroną antyreplay.

**Warunki wykorzystania:** Kontrola dostarczanych kopert lub zapisów serwera; posiadanie starego poprawnego szyfrogramu.

**Dowód lub obserwacja:** `frontend/src/e2ee.ts:424` (const messageBytes = utf8ToBytes(plaintext)); test zmienia conversation_id/id i nadal odszyfrowuje.

**Rekomendacja naprawy:** Audytowany protokół z licznikami, ograniczonym buforem skipped keys i atomowym stanem; uwierzytelniać kontekst zgodnie z API biblioteki. Nie dopisywać własnego protokołu wokół NaCl jako rozwiązania docelowego.

**Priorytet wdrożenia:** P0.

**Test potwierdzający naprawę:** Duplikat, przeniesienie do innej rozmowy, zmiana rodzaju, cytatu i epoki są odrzucane; legalne przestawienie kolejności nadal działa.

### G05 — Pierwsze zaufanie i jedno pole klucza na całe konto

**Poziom ryzyka:** High. **Status:** Otwarte.

**Opis:** syncConversationKeyTrust automatycznie przypina pierwszy klucz; /e2ee/keys nadpisuje pojedynczy e2ee_public_key użytkownika. Każde nowe urządzenie generuje własny klucz i nadpisuje to pole. Fingerprint ma tylko 64 bity i nie jest wymuszoną weryfikacją.

**Wpływ:** MITM pierwszego kontaktu, podmiana przez przejętą sesję i utrata dostępu między urządzeniami. Członkostwo grupy pochodzi od serwera, bez uwierzytelnionych commitów.

**Warunki wykorzystania:** Złośliwy katalog kluczy, nowa instalacja lub przejęty token konta.

**Dowód lub obserwacja:** `frontend/src/e2ee.ts:363` (export async function syncConversationKeyTrust); `backend/server.py:1070` (async def register_e2ee_key)

**Rekomendacja naprawy:** Klucze per urządzenie, podpisany/autoryzowany onboarding nowego urządzenia, key transparency oraz safety numbers z biblioteki. Zmianę grupy potwierdzać przez MLS; historię przekazywać wyłącznie jawną zgodą i E2EE.

**Priorytet wdrożenia:** P0.

**Test potwierdzający naprawę:** Dodanie urządzenia wymaga zatwierdzenia; dwa urządzenia nie nadpisują się; podstawienie pierwszego klucza ujawnia niezgodność niezależnej weryfikacji.

### G06 — Jawne profile, reakcje, grupy i metadane push

**Poziom ryzyka:** High. **Status:** Otwarte.

**Opis:** Backend przechowuje profile/awatary, nazwy grup, emoji reakcji, uczestników, read_by i reply_to. Push ma ogólną treść wiadomości, ale nadal zawiera nazwę nadawcy/grupy, identyfikatory i dane rozmówcy.

**Wpływ:** Baza ujawnia treści profili i relacje społeczne; dostawcy push otrzymują identyfikujące metadane. Niezgodność z wymaganiem szyfrowania wszystkich tych kategorii.

**Warunki wykorzystania:** Odczyt bazy/logów lub dostęp operatora push do wysłanego payloadu.

**Dowód lub obserwacja:** `backend/server.py:517` (def public_user); `backend/server.py:2746` (async def react); `backend/server.py:3948` (common_data = {)

**Rekomendacja naprawy:** Profile, nazwy grup, reakcje i cytaty przenieść do wersjonowanych zdarzeń E2EE; push jako minimalny sygnał pobrania. Ograniczyć status online, retencję i logowanie relacji; sealed sender/private discovery wymagają osobnego projektu.

**Priorytet wdrożenia:** P0 dla treści; P1 dla minimalizacji metadanych.

**Test potwierdzający naprawę:** Zrzut bazy i przechwycony payload push nie zawierają próbnych nazw, emoji, tekstów profilu ani treści. Sporządzić listę nieuniknionych metadanych routingu.

### G07 — Eksportowalne klucze i tokeny w web/desktop

**Poziom ryzyka:** High. **Status:** Otwarte.

**Opis:** Platform.OS=web używa AsyncStorage dla secretKey i tokena. Electron uruchamia eksport web, więc nie używa systemowego magazynu kluczy. Mobilny SecureStore jest poprawą, lecz klucz nadal trafia jako ciąg do JS; nie jest nieeksportowalnym kluczem X25519 w Secure Enclave.

**Wpływ:** XSS, złośliwy bundle lub odczyt profilu aplikacji ujawnia tożsamość E2EE i sesję; PIN interfejsu nie szyfruje tych danych.

**Warunki wykorzystania:** Wykonanie JS w originie aplikacji albo dostęp do profilu systemowego.

**Dowód lub obserwacja:** `frontend/src/tokenStorage.ts:8` (const canUseSecureStore); `frontend/src/e2ee.ts:143` (async function setStoredIdentity); frontend/desktop/main.cjs.

**Rekomendacja naprawy:** Na desktopie osobny proces kryptograficzny i magazyn OS z minimalnym IPC. Na mobile klucz opakowujący chroniony sprzętowo, atomowo szyfrowany stan protokołu i lokalnej bazy. Wymagania background calls pogodzić z polityką odblokowania.

**Priorytet wdrożenia:** P0.

**Test potwierdzający naprawę:** Odczyt plików profilu/backupów nie ujawnia kluczy; renderer nie eksportuje klucza przez IPC; testy na fizycznych urządzeniach i po restarcie.

### G08 — Konfiguracja 2FA mogła wyłączyć aktywne MFA

**Poziom ryzyka:** High. **Status:** Naprawione lokalnie; brak wdrożenia.

**Opis:** /auth/2fa/setup po sprawdzeniu hasła zapisywało two_factor_enabled=False i nowy sekret również przy aktywnym MFA. Brakowało limitów prób setup/enable/disable.

**Wpływ:** Posiadacz sesji i hasła mógł wyłączyć drugi składnik bez jego podania; skradziona sesja umożliwiała nieograniczone próby kodu disable.

**Warunki wykorzystania:** Ważny token; do setup także hasło. Nie jest to obejście logowania samym hasłem bez istniejącej sesji.

**Dowód lub obserwacja:** `backend/server.py:1116` (async def two_factor_setup); 6 testów offline handlerów w backend/tests/test_security_audit_unit.py.

**Rekomendacja naprawy:** Wdrożono odmowę konfiguracji aktywnego MFA, atomowy warunek aktualizacji, limity per konto i ochronę przed zmianą sekretu w wyścigu. Dodatkowo wdrożyć WebAuthn/passkeys, zużywanie TOTP i ponowne uwierzytelnienie operacji wrażliwych.

**Priorytet wdrożenia:** P0.

**Test potwierdzający naprawę:** Aktywne MFA + poprawne hasło daje 409 bez zmiany bazy; limit daje 429; stary sekret nie zmienia nowego. Integracyjny test Mongo oraz TOTP replay nadal wymagany.

### G09 — Unieważnienie sesji nie rozłącza istniejącego WebSocketu

**Poziom ryzyka:** High. **Status:** Otwarte.

**Opis:** Połączenie sprawdza sesję przy otwarciu; pętla nie rewaliduje jej. WSManager indeksuje sockety po użytkowniku, a revoke_user_session nie zamyka socketu konkretnej sesji.

**Wpływ:** Zdalnie wylogowane urządzenie nadal może otrzymywać zdarzenia i wysyłać sygnalizację do końca połączenia.

**Warunki wykorzystania:** Napastnik otworzył WS przed revocation/wygaśnięciem. Nowe HTTP podlega sprawdzeniu sesji.

**Dowód lub obserwacja:** `backend/server.py:234` (async def revoke_user_session); `backend/server.py:5546` (class WSManager); `backend/server.py:5592` (async def websocket_endpoint)

**Rekomendacja naprawy:** Powiązać socket z sid, zamykać przy revocation i terminie sesji, propagować revocation między workerami; sprawdzać stan przy zdarzeniach i okresowo także dla bezczynnych połączeń.

**Priorytet wdrożenia:** P0.

**Test potwierdzający naprawę:** Otworzyć WS, unieważnić sesję na innym urządzeniu/workerze: brak dalszych zdarzeń, zamknięcie socketu i odmowa sygnalizacji.

### G10 — Nieograniczony koszt parsowania przed walidacją rozmiaru

**Poziom ryzyka:** High. **Status:** Otwarte; zależne od reverse proxy.

**Opis:** Upload JSON wywołuje request.json przed limitem binarnym; multipart parsowany jest przed read(limit). WS nie ma aplikacyjnych limitów liczby wiadomości ani jawnego limitu kosztu. Ostateczne limity ASGI/proxy nie są potwierdzone.

**Wpływ:** Wyczerpanie pamięci, CPU lub dysku tymczasowego przez duże/seryjne żądania.

**Warunki wykorzystania:** Dostęp do API, zwykle uwierzytelniony; brak skutecznych limitów na brzegu.

**Dowód lub obserwacja:** `backend/server.py:3214` (async def upload_attachment); websocket_endpoint; backend/requirements.txt (starlette).

**Rekomendacja naprawy:** Limitować rzeczywisty strumień przed dekodowaniem, także chunked; limity pól/części, czasu, użytkownika i współbieżności. Ustawić i testować ws-max-size i rate limit.

**Priorytet wdrożenia:** P1.

**Test potwierdzający naprawę:** Na staging wysłać nadmiarowy strumień bez Content-Length, wiele części i serię ramek; przewidywalne 413/429 bez wzrostu pamięci ponad budżet.

### G11 — Znane podatności zależności npm i Python

**Poziom ryzyka:** High. **Status:** Otwarte.

**Opis:** Skan lockfile zgłasza frontend: 10 high i 17 moderate; root: 3 moderate. Część wyników jest propagacją tej samej podatności przez graf zależności i dotyczy narzędzi buildowych. Dodatkowo pip-audit zgłosił 61 advisory w 15 pakietach przypiętych w backend/requirements.txt, m.in. aiohttp, cryptography, Pillow, PyJWT, python-multipart i Starlette. To wynik bazy advisory, bez dynamicznego potwierdzenia osiągalności.

**Wpływ:** Możliwe ataki na build/dev lub runtime zależnie od konkretnej osiągalnej ścieżki. Liczba podatnych pakietów nie jest liczbą niezależnych exploitów aplikacji.

**Warunki wykorzystania:** Warunki zależne od advisory i użycia biblioteki; dev server nie powinien być publiczny.

**Dowód lub obserwacja:** docs/security/npm-frontend-audit.json; docs/security/npm-root-audit.json; docs/security/pip-audit.json — pełne advisory i zakresy wersji.

**Rekomendacja naprawy:** Ustalić reachable paths i zaktualizować zgodny zestaw Expo/Metro/React Native; osobno zależności serwera. Zaktualizować również zgodny zestaw FastAPI/Starlette/Pydantic i zależności Python po analizie advisory. Nie uruchamiać ślepo npm audit fix --force. Powtórzyć skan, build i testy urządzeń.

**Priorytet wdrożenia:** P1; pilne jeśli osiągalne w produkcji.

**Test potwierdzający naprawę:** Lockfile bez osiągalnych high/critical albo uzasadnione czasowe wyjątki; skan w CI i test aplikacji po aktualizacji.

### G12 — Fallback statycznego serwera wychodził poza dist

**Poziom ryzyka:** High. **Status:** Naprawione lokalnie; wymaga testu HTTP w środowisku docelowym.

**Opis:** findMatchingHtmlFile łączył ścieżkę URL z DIST_DIR bez kontroli wyniku. Ścieżka /../backend/server.py wskazywała plik spoza publicznego katalogu; res.sendFile dostawał ścieżkę absolutną.

**Wpływ:** Potencjalne ujawnienie kodu i dostępnych plików procesu. Dotfiles mogą być blokowane przez sendFile; nie potwierdzono odczytu .env.

**Warunki wykorzystania:** Uruchomiony serwer Node z istniejącym dist oraz ścieżka traversal docierająca bez normalizacji proxy.

**Dowód lub obserwacja:** `server.js:37` (function findMatchingHtmlFile); test funkcji z /../backend/server.py i /../../etc/passwd.

**Rekomendacja naprawy:** Dodano sprawdzenie granicy katalogu po resolve. Publiczny katalog nie może zawierać symlinków do sekretów; używać allowlisty artefaktów builda.

**Priorytet wdrożenia:** P0.

**Test potwierdzający naprawę:** Test funkcji przechodzi; dodatkowo raw HTTP --path-as-is, zakodowane warianty i zachowanie reverse proxy nie mogą ujawnić plików spoza dist.

### G13 — Dowolne protokoły w shell.openExternal desktopa

**Poziom ryzyka:** Medium. **Status:** Naprawione lokalnie.

**Opis:** Nowe okna i nawigacja przekazywały zewnętrzny URL do shell.openExternal bez ograniczenia schematu.

**Wpływ:** Możliwość uruchomienia zarejestrowanego handlera lokalnego/protokołu przez przygotowany link; wpływ zależy od systemu.

**Warunki wykorzystania:** Użytkownik lub treść aplikacji inicjuje nawigację do kontrolowanego adresu.

**Dowód lub obserwacja:** `frontend/desktop/main.cjs:97` (function openExternalWebUrl)

**Rekomendacja naprawy:** Dodano allowlistę http/https; pozostałe schematy są ignorowane. Jeśli wymagane deep linki, osobna ścisła walidacja parametrów.

**Priorytet wdrożenia:** P1.

**Test potwierdzający naprawę:** file:, javascript:, custom: i błędne adresy nie docierają do shell.openExternal; https działa.

### G14 — Usunięcie wiadomości nie usuwa bloba i brak pełnej retencji

**Poziom ryzyka:** Medium. **Status:** Otwarte.

**Opis:** delete_message usuwa rekord wiadomości, nie attachment. Usuwanie znikających wiadomości odbywa się też podczas odczytu; nie ustalono niezależnego GC wszystkich osieroconych blobów. Właściciel może nadal pobrać swój blob.

**Wpływ:** Dłuższe przechowywanie szyfrogramów, metadanych i wzrost storage. Przy późniejszym wycieku klucza statycznego pozostawiony blob zwiększa skutki.

**Warunki wykorzystania:** Usunięta wiadomość z plikiem lub nieaktywna rozmowa; dostęp do serwera/kluczy.

**Dowód lub obserwacja:** `backend/server.py:2772` (async def delete_message); list_messages; get_attachment.

**Rekomendacja naprawy:** Atomowe tombstone/retencja i GC blobów z referencjami, osobna polityka backupów oraz usunięcie lokalnych kluczy wiadomości. Nie obiecywać usunięcia kopii odbiorcy.

**Priorytet wdrożenia:** P1.

**Test potwierdzający naprawę:** Po terminie retencji nie ma rekordu/bloba ani odzyskiwalnej kopii poza udokumentowanym oknem backupu; test także bez otwierania czatu.

### G15 — Długie bearer tokens i brak ochrony sekretu JWT przed złą konfiguracją

**Poziom ryzyka:** Medium. **Status:** Częściowo naprawione lokalnie.

**Opis:** Access token ważny jest 7 dni, główny backend nie ma rotacji refresh. JWT_SECRET był sprawdzany tylko na obecność; dodano minimum 32 bajty, co nie dowodzi entropii.

**Wpływ:** Skradziony token działa do revocation/wygaśnięcia; słaby sekret pozwala podrobić token.

**Warunki wykorzystania:** Wyciek tokena lub operator ustawia przewidywalny sekret.

**Dowód lub obserwacja:** `backend/server.py:40` (JWT_SECRET =); `backend/server.py:140` (def create_access_token)

**Rekomendacja naprawy:** Generować sekret CSPRNG i trzymać w secret managerze; krótkie access tokens, rotacja refresh per urządzenie, wykrywanie reuse i obowiązkowe claims. Nie utożsamiać sesji konta z tożsamością E2EE.

**Priorytet wdrożenia:** P1.

**Test potwierdzający naprawę:** Słaby krótki sekret blokuje start; stary refresh jest jednokrotnego użytku; revocation odcina wszystkie kanały danego urządzenia.

### G16 — PIN jest blokadą interfejsu i autorskim KDF

**Poziom ryzyka:** Medium. **Status:** Otwarte.

**Opis:** PIN używa 20000 iteracji nacl.hash z solą. Nie opakowuje kluczy E2EE; SecureStore nie wymaga uwierzytelnienia użytkownika przy każdym odczycie. Istnieje ścieżka pomijania blokady dla aktywnego połączenia.

**Wpływ:** Przejęcie procesu/JS lub odczyt lokalnego profilu może ominąć PIN; krótki PIN ma małą entropię.

**Warunki wykorzystania:** Dostęp lokalny albo złośliwy kod w aplikacji; obejście przez aktywne połączenie wymaga osobnej weryfikacji UI.

**Dowód lub obserwacja:** `frontend/src/pinLock.tsx:83` (function derivePinHash); shouldBypassPinLockForCall.

**Rekomendacja naprawy:** Oprzeć ochronę kluczy na magazynie OS i jego ograniczaniu prób. Jeśli potrzebny KDF hasła — standardowa biblioteka Argon2id. Ograniczyć wyjątek dla rozmowy do samego ekranu połączenia.

**Priorytet wdrożenia:** P1.

**Test potwierdzający naprawę:** Zablokowany klient nie udostępnia czatów przez deep link/back navigation; test snapshotów, schowka, restartu i odczytu kluczy na fizycznym urządzeniu.

### G17 — Ujawnienie IP przez fallback bezpośredniego WebRTC

**Poziom ryzyka:** Medium. **Status:** Otwarte.

**Opis:** Web używa iceTransportPolicy=all, a mobile może przejść z relay do połączenia bezpośredniego. Dostępne publiczne STUN.

**Wpływ:** Rozmówca może poznać adres sieciowy, a STUN/TURN widzi metadane połączeń. DTLS-SRTP chroni media, nie anonimizuje transportu.

**Warunki wykorzystania:** Zestawienie rozmowy w trybie all/fallback; kontrolowany rozmówca.

**Dowód lub obserwacja:** `frontend/app/call/[id].tsx:1043` (iceTransportPolicy:); fallback „trying direct connection”.

**Rekomendacja naprawy:** Udostępnić restrykcyjny tryb relay-only bez automatycznego downgrade, z jasno opisanym kosztem dostępności. Krótkie dane TURN, retencja i testy routingu.

**Priorytet wdrożenia:** P1.

**Test potwierdzający naprawę:** W trybie prywatnym peer widzi wyłącznie relay; awaria TURN kończy próbę zamiast ujawniać host/srflx.

### G18 — Brak dowodów bezpieczeństwa wydawania, backupów i infrastruktury

**Poziom ryzyka:** Info. **Status:** Nieweryfikowalne na podstawie checkoutu.

**Opis:** Nie dostarczono działającego środowiska audytowego, konfiguracji produkcyjnej proxy/bazy, polityki backupów, uprawnień CI, podpisanych binariów ani zewnętrznego audytu. Repozytorium nie daje podstaw do potwierdzenia tych kontroli.

**Wpływ:** Nie można certyfikować odporności infrastruktury ani potwierdzić zgodności wdrożenia z kodem.

**Warunki wykorzystania:** Brak materiałów; to luka dowodowa, nie dowód złamania zabezpieczeń.

**Dowód lub obserwacja:** frontend/eas.json; frontend/android/app/build.gradle; scripts/deploy-vps-release.sh; brak dostarczonych dowodów operacyjnych.

**Rekomendacja naprawy:** Dostarczyć materiały wymienione w zakresie; niezależny audyt aplikacji i protokołu przed produkcją. Zweryfikować także nieśledzony portal GhostelAPPweb.

**Priorytet wdrożenia:** P0 — bramka akceptacyjna produkcji.

**Test potwierdzający naprawę:** Udokumentowana weryfikacja podpisu i pochodzenia binariów, restore backupu, skan infrastruktury oraz niezależny retest.

## Ryzyko dla użytkowników

Nie należy przedstawiać Ghostel jako równoważnego Signal. Użytkownik może utracić historyczną poufność po kradzieży jednego klucza; niezależnie od szyfrowania treści operator widzi szeroki graf komunikacji. Nowe urządzenie nie ma bezpiecznej synchronizacji historii. Istniejące kopie historii nie stają się forward-secret po migracji — wymagają odrębnej polityki retencji i komunikatu dla użytkowników.

## Priorytety napraw

| Priorytet | Zakres | Kryterium zamknięcia |
|---|---|---|
| P0 | G01–G09 oraz G12 i bramka G18 | Ochrona tożsamości i sesji, docelowy protokół, autentykowany klient, niezależny retest |
| P1 | DoS, zależności, retencja, tokeny, magazyn/PIN, metadane transportu | Testy staging/urządzeń, limity i polityki oraz aktualny SBOM |
| P2 | Dalsza redukcja metadanych, reprodukowalne wydania, ciągły fuzzing | Mierzalne ograniczenia danych i powtarzalne kontrole |

Poziomy Low nie zostały użyte tylko po to, by wypełnić wszystkie kategorie. Info oznacza lukę dowodową, której krytyczność bramki wydania może być wysoka.

## Rekomendowana docelowa architektura E2EE

1. Podpisane klienty natywne z chronionym kanałem wydań i kryptografią w wydzielonym module. Web ma jawnie słabszy model zaufania do dostawcy kodu; przejęcie całej infrastruktury wraz z autorytetem podpisywania nie daje się naprawić samym E2EE.
2. 1:1: utrzymywana implementacja Signal, inicjalizacja zgodna z bieżącą specyfikacją biblioteki (preferowana obsługiwana PQXDH), ratchet i mechanizmy postkwantowe tam, gdzie biblioteka je wspiera. Najpierw ocena licencji, API, wspieranych platform i niezależnych audytów; nie wybierać pakietu jedynie po nazwie.
3. Oddzielna tożsamość konta/urządzenia, autoryzowana lista urządzeń i sesje per urządzenie, publiczne prekeys bez prywatnego materiału na backendzie. Bezpieczne dołączenie QR/autoryzacją istniejącego urządzenia, widoczne odwołanie urządzenia i key transparency.
4. Grupy: utrzymywana implementacja MLS, podpisane zmiany członkostwa i epoki, recovery po przerwie offline. Serwer routuje szyfrogramy; nie może sam dodawać członków niezauważalnie.
5. Jedna wersjonowana zaszyfrowana treść zdarzenia obejmująca tekst, reakcję, cytat, edycję, dane profilu i grupy. Kontekst jest uwierzytelniany w standardowy sposób. Format ma sztywne limity i jawne negocjowanie wersji bez downgrade.
6. Duże pliki: audytowany streaming AEAD, losowy klucz per plik, integralność całego strumienia/kolejności; klucz i prywatne metadane tylko wewnątrz wiadomości E2EE. Losowe nazwy blobów i limity/quota.
7. Magazyn OS opakowuje klucz szyfrowanej lokalnej bazy i stanu protokołu; atomowy zapis liczników, ochrona przed rollback, backup bez surowych kluczy. Nie obiecywać sprzętowego X25519, jeśli platforma go nie udostępnia.
8. Backup opcjonalny: losowy klucz odzyskiwania albo silne hasło z Argon2id z parametrami dobranymi benchmarkiem urządzeń, losowa sól, wersjonowane parametry i AEAD. Serwer nigdy nie otrzymuje hasła ani prywatnych kluczy. Reset konta nie odzyskuje automatycznie historii.
9. Backend: krótkie sesje, passkeys/MFA, revocation również WS i push, segregacja środowisk, minimalizacja logów i routing pseudonimowy. Push tylko jako sygnał, prywatny tryb relay-only, jasno określona retencja.

## Checklist bezpieczeństwa

| Obszar | Stan po poprawkach lokalnych |
|---|---|
| Tekst/obraz/audio/plik szyfrowane lokalnie | Częściowo potwierdzone ścieżką kodu; brak testów urządzeń |
| Prywatny klucz niewysyłany przez API | Nie znaleziono wysyłania w analizowanych ścieżkach |
| FS / PCS / Signal / MLS | NIE |
| Weryfikacja klucza przy odbiorze | Pin sprawdzany; pierwszy kontakt nadal TOFU |
| Replay/downgrade i związanie kontekstu | NIE; legacy plaintext przy odbiorze także wymaga migracji |
| Bezpieczne urządzenia/grupy/kanały | Jeden klucz na konto; kanałów nie zidentyfikowano |
| E2EE profili/reakcji/nazw grup | NIE |
| Tokeny/klucze mobile | SecureStore; wymagane testy sprzętu, backupu i procesu |
| Tokeny/klucze desktop/web | AsyncStorage — NIE dla wymaganego poziomu |
| PIN/biometria/root/debug/pinning | PIN UI; pozostałe niezależnie niezweryfikowane lub niewdrożone |
| 2FA setup/limity | Poprawione lokalnie; phishing-resistant MFA i TOTP anti-replay nadal brak |
| Reset/odzyskiwanie konta | Nie zidentyfikowano pełnego flow w głównym backendzie; nie oznacza bezpiecznego recovery |
| Odwołanie HTTP/WS | HTTP kontrolowane, aktywne WS nadal luka |
| CORS/TLS | CORS konfigurowalny, brak weryfikacji produkcyjnego TLS; nginx przykład HTTP nie dowodzi produkcji HTTP |
| IDOR | Kontrole członkostwa/właściciela obecne; brak pełnego dynamicznego testu wszystkich endpointów |
| Retencja/usunięcie/backup | Częściowe; brak potwierdzenia pełnego GC i szyfrowania backupów |
| Push/logi/metadane | Treść wiadomości ogólna, ale nazwy/ID i graf relacji nadal ujawniane |
| Aktualizacje i supply chain | Konfiguracje build istnieją; podpisy produkcyjne i kontrola CI niezweryfikowane |
| Secret scan | Ograniczony skan; jedyne trafienie to krótki placeholder w przykładzie Firebase |
| Niezależny audyt | NIEWYKONANY w ramach tego zadania |

## Plan wdrożenia poprawek

Etap 1: review i wdrożenie zawartych małych poprawek, testy staging dla 2FA i traversal, sprawdzenie wymaganej długości konfiguracji JWT. Nie rotować kluczy E2EE automatycznie ani usuwać historii. Zmiana pinów może ukryć wcześniejsze wiadomości — przygotować procedurę migracji i czytelny komunikat.

Etap 2: usunąć lukę WS, ustalić limity zasobów i politykę retencji, ograniczyć push, przeprowadzić aktualizację zgodnego zestawu zależności. Rozdzielić dane profilu publicznego od prywatnego. Ograniczyć konto administratora portalu i zweryfikować separację JWT/sekretów między usługami.

Etap 3: decyzja architektoniczna i integracja biblioteki Signal/MLS z klientami oraz nowym API urządzeń/prekeys. Prototyp na testowych kontach; wektory interoperacyjności, restarty, utrata kolejności, równoległe urządzenia, granice rozmiaru i stan offline. Nie publikować własnej nieaudytowanej implementacji.

Etap 4: migracja z jawnie zatwierdzonymi tożsamościami. Nowe rozmowy tylko nowym protokołem; stare szyfrogramy w wydzielonym czytniku archiwum, bez cichego fallbacku. Minimalna wspierana wersja klienta i mechanizm blokady downgrade. Historyczne klucze przechowywać tylko jeśli użytkownik świadomie zachowuje archiwum.

Etap 5: niezależny audyt protokołu/integracji, pentest urządzeń i infrastruktury, retest napraw oraz podpisane wydanie. Bramka: brak otwartych Critical/High w zakresie produkcyjnym; wyjątki wymagają jawnej decyzji ryzyka i nie mogą zaprzeczać deklaracjom produktu.

## Rekomendacje długoterminowe

Utrzymywać threat model i spis danych, SBOM dla każdego buildu, skany SAST/SCA/sekretów w CI, chronione gałęzie i aprobaty wydań, izolowane krótkotrwałe build runners i chronione klucze podpisujące. Fuzzować parser kopert, załączników, komunikatów MLS, deep linki i IPC; testować rollback i awarie zapisu stanu. Regularnie ćwiczyć utratę urządzenia, kompromitację sesji/serwera, rotację infrastrukturalnych sekretów i odtwarzanie backupów. Publikować politykę bezpieczeństwa i odpowiedzialnego zgłaszania luk; powtórzyć niezależny audyt po zmianie protokołu.

## Dowody i walidacja

- `tests/security-audit.cjs`: testy rzeczywistych funkcji po transpile TS, z lokalnymi atrapami; test „CONFIRMED OPEN” przechodzi **dlatego, że odtwarza nadal istniejącą lukę**, nie dlatego, że replay naprawiono.
- `backend/tests/test_security_audit_unit.py`: 6 testów handlerów MFA, bez sieci i bazy; wynik w `mfa-tests.txt`. Testy JS: 5/5, wynik w `node-tests.txt`.
- `backend/tests/test_call_transitions_unit.py`: 10 istniejących testów regresyjnych przechodzi. `frontend/tests/calls.test.cjs`: 12/12 przechodzi, wynik w `calls-tests.txt`. Łącznie uruchomiono 33 testy, wszystkie przeszły; jeden z nich celowo potwierdza otwartą lukę protokołu.
- `docs/security/npm-*-audit.json`: surowe wyniki SCA registry npm dla lockfile; ocena osiągalności wymaga dalszej pracy.
- `docs/security/pip-audit.json`: skan przypiętych requirements przez pip-audit z `--no-deps --disable-pip`; 61 advisory/15 pakietów, zero pominiętych pozycji. Nie rozwiązywano dodatkowych zależności tranzytywnych ani nie instalowano aplikacji. Narzędzie uruchomiono w osobnym tymczasowym venv; ostrzegło o systemowym LibreSSL.
- `docs/security/secret-scan.json`: tylko śledzony working tree i wybrane wzorce; placeholder Firebase ma 10 znaków w treści klucza, nie jest potwierdzonym rzeczywistym sekretem. Nie skanowano pełnej historii ani plików ignorowanych.
- `docs/security/typescript-check.txt`: pełny `tsc --noEmit` nie przechodzi przez błąd typu routingu w niezmienionym `src/IncomingCallProvider.tsx:299`. Brak błędu wskazującego zmieniony e2ee.ts w tym uruchomieniu; nie oznacza to zaliczenia pełnego builda.
- `node --check` obu zmienionych serwerów JS i `git diff --check`: poprawne.

Testy do wykonania na staging: pełna macierz autoryzacji i IDOR, origin WS, wygaśnięcie/revocation we wszystkich workerach, bruteforce i replay TOTP, credential stuffing, enumeration oraz koszt regex wyszukiwania, chunked/multipart DoS, podmiana/replay/downgrade E2EE, modyfikacja członkostwa, błędne nonce/klucze/base64, backup/restore i onboarding wielu urządzeń, MITM/TLS, przekierowania/deep links, pamięć/cache/schowek/screenshoty i podpisy aktualizacji. Wszystkie na danych syntetycznych i z limitami testu.
