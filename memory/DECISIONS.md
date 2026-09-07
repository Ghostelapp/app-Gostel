# DECISIONS.md

## Ważne decyzje architektoniczne

### 1. Backend jako jeden plik `server.py`

**Decyzja:** Cały backend znajduje się w jednym pliku.
**Powód:** Prawdopodobnie szybki rozwój MVP i iteracji.
**Konsekwencje:** Trudność w nawigacji, testowaniu i utrzymaniu.
**Rekomendacja:** Refaktoryzacja do modułów, ale wymaga czasu i testów.

### 2. Osobny projekt iOS (`IOS/GhostelIOS/`)

**Decyzja:** Istnieje osobny katalog z natywnymi plikami iOS.
**Powód:** Prawdopodobnie potrzeba customowych natywnych modyfikacji (CallKit, VoIP push), których nie dało się łatwo zrobić w czystym Expo prebuild.
**Konsekwencje:** Duplikacja kodu screens i src między `frontend/` a `IOS/GhostelIOS/`.
**Rekomendacja:** Zweryfikować czy nadal potrzebny. Jeśli tak — zintegrować natywne pliki z głównym frontendem. Jeśli nie — usunąć.

### 3. WebSocket + polling fallback

**Decyzja:** Komunikacja realtime przez WebSocket z 5-sekundowym pollingiem fallback.
**Powód:** Niezawodność na mobilnych połączeniach, gdzie WebSocket może być zamykany.
**Konsekwencje:** Większa złożoność, ale lepsza niezawodność.

### 4. E2EE przez backend relay

**Decyzja:** Klucze publiczne i szyfrowane payloady przechodzą przez backend.
**Powód:** Brak możliwości implementacji pełnego Signal Protocol w krótkim czasie.
**Konsekwencje:** Backend widzi metadane (kto, kiedy, do kogo), ale nie treść wiadomości.
**Rekomendacja:** Docelowo wdrożyć prawdziwy E2EE (Signal Protocol lub podobny).

### 5. FCM + APNs VoIP push

**Decyzja:** Osobne ścieżki push dla Android (FCM) i iOS (APNs VoIP dla połączeń, regularne dla wiadomości).
**Powód:** iOS wymaga VoIP push dla CallKit, Android używa FCM.
**Konsekwencje:** Podwójna konfiguracja i monitoring.

### 6. S3 do załączników

**Decyzja:** Załączniki przechowywane w S3 (lub compatible).
**Powód:** Skalowalność i niezawodność.
**Konsekwencje:** Wymaga konfiguracji AWS/S3 w `.env`.

### 7. MongoDB jako jedyna baza

**Decyzja:** Wszystkie dane w MongoDB.
**Powód:** Elastyczność schematu, dobra integracja z Python/FastAPI.
**Konsekwencje:** Brak relacji SQL, trzeba dbać o indeksy i spójność.
