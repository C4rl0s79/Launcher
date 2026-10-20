# engine/ — klient EmuStart w Lumen

Ten katalog to `git subtree` repozytorium EmuStart (github.com/C4rl0s79/EmuStart). Obecnie:
**`main`, v0.48.1** (commit 143e29d). Launcher nie zmienia repozytorium EmuStart — własne dodatki są tylko tutaj.
Historia EmuStart jest zachowana w historii tego repozytorium.

Zmiany na potrzeby Lumen są opisane w `CHANGELOG.md` → `[Nieopublikowane]` → „Lumen — EmuStart jako
silnik” oraz w `../docs/INTEGRATION.md` (tabela plików). Samodzielny EmuStart (`main.py`,
`server_main.py`) działa z tego katalogu tak samo jak w repozytorium źródłowym.

## Aktualizacja z EmuStart

```bash
git subtree pull --prefix engine https://github.com/C4rl0s79/EmuStart.git main
```

Konflikty bywają w `web/app.js`
(fragmenty Lumen obok nowego kodu — zwykle zostają oba) i `CHANGELOG.md` (sekcja Lumen w
`[Nieopublikowane]`). Po aktualizacji:
`npm run test:engine`, `npm test`, a przy zmianach w `web/app.js` — sprawdzić, czy most `?lumen`
i fragmenty oznaczone `LUMEN` / `isSteam` nadal pasują.

## Budowa silnika

```bash
npm run build:engine
```

→ `engine/dist/EmuStartEngine/EmuStartEngine.exe` (PyInstaller, `lumen-engine.spec`, bez pywebview).
