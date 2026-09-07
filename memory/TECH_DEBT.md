# TECH_DEBT.md

## Dług techniczny

### 1. Monolityczny backend — CZĘŚCIOWO ROZWIĄZANY

- `backend/server.py` został podzielony na `backend/app/`:
  - `routes/` — endpointy pogrupowane per domena
  - `services/` — logika biznesowa
  - `models.py` — modele Pydantic
  - `core/` — konfiguracja, database, utils, auth
- **Pozostałość:** W `server.py` nadal znajdują się duplikaty helperów i modeli, które powinny być usunięte po pełnym przejściu na importy z `app/`.
- **Plan:** Oczyszczenie `server.py` z nieużywanych definicji.

### 2. Duplikacja kodu iOS — ROZWIĄZANE

- `IOS/GhostelIOS/` został usunięty.
- Buildy iOS są robione z głównego projektu `frontend/`.
- **Status:** rozwiązane

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

### 6. Frontend package.json vs app.json wersja — ROZWIĄZANE

- Wersje zsynchronizowane do `1.4.54`.
- `app.json`: iOS build 66, Android versionCode 61.
- **Status:** rozwiązane

### 7. Brak CI/CD

- Brak GitHub Actions do testów/buildów.
- **Koszt:** Średni.
- **Plan:** Dodać workflowy dla backend tests, lint, EAS build.

### 8. Brak Sentry/observability

- Aplikacja loguje lokalnie, brak centralnego monitoringu błędów.
- **Koszt:** Średni (trudność w diagnozowaniu produkcji).
- **Plan:** Rozważyć Sentry lub podobne narzędzie.
