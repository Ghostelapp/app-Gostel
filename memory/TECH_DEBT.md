# TECH_DEBT.md

## Dług techniczny

### 1. Monolityczny backend

- `backend/server.py` zawiera wszystko: modele, endpointy, logikę biznesową, WebSocket, push.
- **Koszt:** Wysoki. Każda zmiana wymaga analizy dużego pliku.
- **Plan:** Podzielić na:
  - `routes/` — endpointy pogrupowane per domena
  - `services/` — logika biznesowa
  - `models/` — Pydantic models
  - `repositories/` — dostęp do MongoDB
  - `middleware/` — auth, rate limiting, CORS
  - `core/` — konfiguracja, logging

### 2. Duplikacja kodu iOS

- `IOS/GhostelIOS/` vs `frontend/` — duplikacja screens i src.
- **Koszt:** Średni. Każda zmiana w UI może wymagać synchronizacji.
- **Plan:** Zintegrować natywne pliki iOS z głównym frontendem lub usunąć jeśli nieużywane.

### 3. Brak modularnego zarządzania błędami

- Wiele miejsc zwraca `HTTPException` bez wspólnego schematu błędów.
- **Koszt:** Średni.
- **Plan:** Wprowadzić wspólne klasy wyjątków i handler.

### 4. Brak migracji bazy danych

- Brak narzędzia do migracji MongoDB.
- **Koszt:** Średni. Zmiany w schemacie wymagają ręcznych skryptów.
- **Plan:** Rozważyć migracje przez skrypty lub narzędzie typu `migrate-mongo`.

### 5. Testy integracyjne wymagają działającego backendu

- Testy w `backend/tests/` są integracyjne i wymagają MongoDB.
- **Koszt:** Niski/średni.
- **Plan:** Dodać więcej unit testów z mockami.

### 6. Frontend package.json vs app.json wersja

- Niespójność wersji.
- **Koszt:** Niski.
- **Plan:** Ujednolicić i ewentualnie zautomatyzować bumpowanie.

### 7. Brak CI/CD

- Brak GitHub Actions do testów/buildów.
- **Koszt:** Średni.
- **Plan:** Dodać workflowy dla backend tests, lint, EAS build.

### 8. Brak Sentry/observability

- Aplikacja loguje lokalnie, brak centralnego monitoringu błędów.
- **Koszt:** Średni (trudność w diagnozowaniu produkcji).
- **Plan:** Rozważyć Sentry lub podobne narzędzie.
