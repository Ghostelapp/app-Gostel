# CHANGELOG_AI.md

## 2026-09-07 — Audyt i pamięć projektu

### Co zmieniono

- Utworzono katalog `memory/` z pełną dokumentacją projektu.
- Przeprowadzono audyt struktury, API, bazy danych, auth, zależności.
- Zidentyfikowano duplikację `IOS/GhostelIOS/`.
- Znaleziono niespójność wersji `frontend/package.json` vs `frontend/app.json`.
- Zidentyfikowano artefakty buildów do posprzątania.

### Pliki

- `memory/PROJECT_CONTEXT.md`
- `memory/ARCHITECTURE.md`
- `memory/FEATURES.md`
- `memory/FILE_STRUCTURE.md`
- `memory/API.md`
- `memory/DATABASE.md`
- `memory/AUTH_AND_ROLES.md`
- `memory/EXTERNAL_SERVICES.md`
- `memory/KNOWN_ISSUES.md`
- `memory/TECH_DEBT.md`
- `memory/CHANGELOG_AI.md`
- `memory/DECISIONS.md`

### Dlaczego

Projekt osiągnął rozmiar wymagający uporządkowanej dokumentacji. Monolityczny backend i duplikacja kodu iOS zwiększają ryzyko regresji. Dokumentacja pozwoli przyszłym agentom szybciej zrozumieć system.

### Ryzyko

Brak — same pliki dokumentacyjne.

### Test

Brak testów automatycznych dla dokumentacji.
