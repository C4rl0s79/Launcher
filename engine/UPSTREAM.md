# engine/ — klient EmuStart w Lumen

Ten katalog to `git subtree` repozytorium EmuStart (github.com/C4rl0s79/EmuStart), dodany z gałęzi
`feature/savesync-server` (commit ea28eb7: `main` 0.45.1 + serwer synchronizacji zapisów, etap 1,
i klient etap 2 część 1). Historia EmuStart jest zachowana w historii tego repozytorium.

Zmiany na potrzeby Lumen są opisane w `CHANGELOG.md` → `[Nieopublikowane]` → „Lumen — EmuStart jako
silnik” oraz w `../docs/INTEGRATION.md` (tabela plików). Samodzielny EmuStart (`main.py`,
`server_main.py`) działa z tego katalogu tak samo jak w repozytorium źródłowym.

## Aktualizacja z EmuStart

```bash
git subtree pull --prefix engine emustart main
```

(zdalne `emustart` wskazuje lokalny klon `D:\GIT\Emustart`; wypychanie jest wyłączone). Po aktualizacji:
`npm run test:engine`, `npm test`, a przy zmianach w `web/app.js` — sprawdzić, czy most `?lumen`
i fragmenty oznaczone `LUMEN` / `isSteam` nadal pasują.

## Budowa silnika

```bash
npm run build:engine
```

→ `engine/dist/EmuStartEngine/EmuStartEngine.exe` (PyInstaller, `lumen-engine.spec`, bez pywebview).
