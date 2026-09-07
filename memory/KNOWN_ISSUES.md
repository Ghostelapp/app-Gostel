# KNOWN_ISSUES.md

## Znalezione problemy

### 🔴 CRITICAL

Brak krytycznych problemów bezpieczeństwa wykrytych podczas audytu.

### 🟠 HIGH

#### 1. Niespójność wersji frontend

- `frontend/package.json`: `1.4.53`
- `frontend/app.json`: `1.4.54`
- **Wpływ:** Może prowadzić do pomyłek przy buildach i wersjonowaniu.
- **Rozwiązanie:** Ujednolicić wersję do `1.4.54` (lub nowszej).
- **Status:** do naprawy

#### 2. Duplikacja projektu iOS

- `IOS/GhostelIOS/` zawiera osobny projekt iOS, który jest subsetem `frontend/`.
- Brak 4 nowszych ekranów ustawień.
- **Wpływ:** Ryzyko, że buildy iOS używają starszego kodu. Trudność w utrzymaniu dwóch kopii.
- **Rozwiązanie:** Zdecydować czy IOS/GhostelIOS jest nadal potrzebny, czy można go usunąć/zintegrować.
- **Status:** do zweryfikowania

#### 3. Backend jako monolit

- `backend/server.py` ma ~6k linii, 171 funkcji.
- **Wpływ:** Trudny w utrzymaniu, testowaniu i debugowaniu. Wysokie ryzyko regresji przy zmianach.
- **Rozwiązanie:** Podzielić na moduły (routes, services, models).
- **Status:** do zaplanowania

### 🟡 MEDIUM

#### 4. Artefakty buildów w repozytorium

- `android-1.4.54.aab`, `frontend/app-release-1.4.5*.apk`, `DEPLOY_PACKAGE_v1.4.54/`
- Są untracked, ale zajmują miejsce i mogą być przypadkowo dodane do git.
- **Rozwiązanie:** Dodać do `.gitignore` i usunąć z worktree.
- **Status:** do posprzątania

#### 5. Brak `frontend/ios/`

- Główny frontend nie ma katalogu `ios/`, co może utrudniać lokalne debugowanie iOS.
- **Rozwiązanie:** Wygenerować prebuild iOS lub używać `IOS/GhostelIOS/`.
- **Status:** do zweryfikowania

#### 6. Testy backendu mogą zawierać hardcoded credentials

- `backend/tests/test_silentel_api.py` ma `ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin@2026!")`
- **Wpływ:** Fallback hasło w kodzie testowym.
- **Rozwiązanie:** Usunąć fallback, wymusić `.env`.
- **Status:** do naprawy

### ⚪ LOW

#### 7. Wiele plików testowych w root

- `backend_test_*.py` w root projektu.
- **Rozwiązanie:** Przenieść do `backend/tests/` lub `scripts/`.
- **Status:** do posprzątania

#### 8. Stare dokumentacje w root

- `VPS-DEPLOY-INSTRUCTIONS.md`, `QUICK-VPS-COMMANDS.txt`, `DEPLOY_PACKAGE_v1.4.54/`
- **Rozwiązanie:** Przenieść do `docs/` lub `memory/`.
- **Status:** do posprzątania

#### 9. `IOS/GhostelIOS/package.json` wersja 1.4.0

- Starsza wersja niż frontend.
- **Rozwiązanie:** Zaktualizować lub usunąć projekt.
- **Status:** do zweryfikowania
