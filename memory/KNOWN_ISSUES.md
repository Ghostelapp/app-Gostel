# KNOWN_ISSUES.md

## Znalezione problemy

### 🔴 CRITICAL

Brak krytycznych problemów bezpieczeństwa wykrytych podczas audytu.

### 🟠 HIGH

#### 1. Niespójność wersji frontend — NAPRAWIONE

- `frontend/package.json`: `1.4.54`
- `frontend/app.json`: `1.4.54` (iOS build 66, Android versionCode 61)
- **Status:** naprawione

#### 2. Duplikacja projektu iOS — USUNIĘTE

- `IOS/GhostelIOS/` został usunięty.
- Buildy iOS są robione z głównego projektu `frontend/`.
- **Status:** rozwiązane

#### 3. Backend jako monolit — ZMODULARYZOWANY

- `backend/server.py` został podzielony na `backend/app/`:
  - `core/` — config, database, utils, auth
  - `models.py` — modele Pydantic
  - `services/` — push, calls, websocket, users, conversations, admin
  - `routes/` — auth, users, contacts, conversations, admin, uploads, push, support, root
- Wszystkie 94 trasy API są rejestrowane przez `include_router`.
- **Status:** rozwiązane (pozostało uporządkowanie duplikatów w server.py)

### 🟡 MEDIUM

#### 4. Artefakty buildów w repozytorium

- `android-1.4.54.aab`, `frontend/app-release-1.4.5*.apk`, `DEPLOY_PACKAGE_v1.4.54/`
- Są untracked, ale zajmują miejsce i mogą być przypadkowo dodane do git.
- **Rozwiązanie:** Dodać do `.gitignore` i usunąć z worktree.
- **Status:** do posprzątania

#### 5. Brak `frontend/ios/`

- Główny frontend nie ma katalogu `ios/`, co może utrudniać lokalne debugowanie iOS.
- **Rozwiązanie:** Wygenerować prebuild iOS (`npx expo prebuild --platform ios`).
- **Status:** do zweryfikowania

#### 6. Testy backendu mogą zawierać hardcoded credentials

- `backend/tests/test_silentel_api.py` ma `ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin@2026!")`
- **Wpływ:** Fallback hasło w kodzie testowym.
- **Rozwiązanie:** Usunąć fallback, wymusić `.env`.
- **Status:** do naprawy

### ⚪ LOW

#### 7. Wiele plików testowych w root — CZĘŚCIOWO ROZWIĄZANE

- Pliki smoke-test przeniesiono do `scripts/smoke-tests/`.
- **Status:** częściowo rozwiązane

#### 8. Stare dokumentacje w root — CZĘŚCIOWO ROZWIĄZANE

- Dokumentacje deploy przeniesiono do `docs/deployment/`.
- **Status:** częściowo rozwiązane

#### 9. `IOS/GhostelIOS/package.json` wersja 1.4.0 — USUNIĘTE

- Projekt `IOS/GhostelIOS/` został usunięty.
- **Status:** rozwiązane
