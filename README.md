# Lumen — launcher biblioteki Steam do obsługi z kanapy

Lumen to lokalna aplikacja desktopowa (Windows) z przejrzystym, ciemnym interfejsem do przeglądania
i uruchamiania gier Steam klawiaturą, myszą lub kontrolerem. Górny pasek to **Start** (ostatnio grane
i nowo dodane), **przypięte grupy** (np. Wszystkie gry, Zainstalowane, Ulubione, Twoje kolekcje Steam —
LB/RB lub Q/E przełączają) i **Ustawienia**. Każda grupa to pełna siatka plakatów jak w bibliotece Steam,
a każda gra ma ekran szczegółów z jedną, jednoznaczną akcją główną. Nie ma tu newsów, reklam ani
aktywności znajomych.

- **Nie wymaga logowania do Steam** ani hasła — czyta pliki klienta Steam na dysku (tylko odczyt).
- **Uruchamianie i instalacja** są przekazywane do klienta Steam (`steam://rungameid/…`, `steam://install/…`).
- **Pełna biblioteka konta** (także niezainstalowane gry) — opcjonalnie przez oficjalne Steam Web API z Twoim kluczem.
- **Kolekcje Steam** — Twoje statyczne kolekcje ze Steama (tylko odczyt) można przypiąć jako grupy na górnym pasku.
- **Nowo dodane** — Steam nie udostępnia daty zakupu (ani lokalnie, ani w Web API), więc Lumen zapisuje, kiedy gra pierwszy raz pojawiła się w bibliotece (`first-seen.json`, odporne na reinstalację); skróty z emulatorów mają datę pliku ROM.
- **Grafiki** — SteamGridDB (opcjonalny klucz) albo oficjalne grafiki Steam; lokalny cache.
- **Skróty spoza Steama** — gry dodane do Steama np. przez Steam ROM Manager (emulatory) są czytane z `shortcuts.vdf`, z grafikami z folderu `grid` Steama, i uruchamiane przez Steam.
- **Opisy gier spoza Steama** — z bazy LaunchBox Games DB pobieranej przez program (Ustawienia → „Pobierz bazę LaunchBox”, ~110 MB, ok. 20–30 s); potem działa offline. Opisy są po angielsku (taka jest baza).
- **Własne kategorie, ulubione, przypięcia** — zapisywane lokalnie (Ustawienia → Kategorie; gry przypisujesz w ekranie gry → „Kategorie”).

## Wymagania

- Windows 10/11 x64 (inne systemy nie były testowane).
- Zainstalowany klient Steam (bez niego aplikacja działa, ale nie ma czego pokazać — jest tryb demo).
- Do budowania ze źródeł: Node.js 22+ (sprawdzone na 24.16) i npm.

## Szybki start (ze źródeł)

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` uruchamia aplikację z przeładowaniem na żywo. Wersja produkcyjna bez serwera deweloperskiego:

```bash
npm run build
```

```bash
npm start
```

## Budowanie wersji do uruchamiania poza środowiskiem programistycznym

```bash
npm run dist
```

Wynik w katalogu `release/`:

| Plik | Opis |
| --- | --- |
| `Lumen-<wersja>-setup.exe` | instalator (wybór katalogu, skróty w menu Start i na pulpicie) |
| `Lumen-<wersja>-portable.exe` | pojedynczy plik bez instalacji |
| `win-unpacked/Lumen.exe` | rozpakowana aplikacja (szybki podgląd: `npm run dist:dir`) |

Pliki nie są podpisane certyfikatem, więc Windows SmartScreen może przy pierwszym uruchomieniu pokazać ostrzeżenie.

## Konfiguracja

Wszystko konfiguruje się w aplikacji: **Ustawienia** (klawisz `O` lub przycisk ☰ / Start na padzie).
Plik konfiguracyjny nie jest potrzebny.

### Steam (pełna biblioteka konta — opcjonalnie)

Bez klucza Lumen pokazuje **tylko gry wykryte na dysku** i wyraźnie to komunikuje.
Aby zobaczyć wszystkie posiadane gry:

1. Wygeneruj osobisty klucz Steam Web API: <https://steamcommunity.com/dev/apikey>
   (wymaga konta Steam z aktywnym zakupem; jako domenę możesz wpisać np. `localhost`).
2. W Lumen: **Ustawienia → Steam → Klucz Steam Web API** → wklej → **Zapisz**.
3. Konto (SteamID64) jest wykrywane automatycznie z aktualnie zalogowanego użytkownika Steam.
   W razie potrzeby wpisz inne w polu „Inne SteamID64”.
4. Jeśli Steam zwraca pustą listę, ustaw w profilu Steam: *Prywatność → Szczegóły gry → Publiczne*.

### SteamGridDB (grafiki — opcjonalnie)

1. Zaloguj się na <https://www.steamgriddb.com> i skopiuj klucz z *Preferences → API*
   (<https://www.steamgriddb.com/profile/preferences/api>).
2. W Lumen: **Ustawienia → Grafiki → Klucz SteamGridDB** → wklej → **Zapisz**.
3. Przełącznik „Najpierw grafiki ze SteamGridDB” decyduje, czy domyślnie używać SteamGridDB, czy oficjalnych grafik Steam.
4. W ekranie gry: **Grafiki** — wybór plakatu / tła / logo / ikony, własny plik, „Zmień dopasowanie gry”.

### Gdzie są dane

Wersja instalowana: `%APPDATA%\Lumen\`. **Wersja portable**: folder `LumenData\` obok `Lumen-…-portable.exe`
(cały program razem z bazą LaunchBox można przenieść na inny dysk lub komputer; klucze API są szyfrowane
dla konta Windows, więc na innym komputerze trzeba je wpisać ponownie).

| Ścieżka | Zawartość | Kasowane przez „Wyczyść pamięć podręczną” |
| --- | --- | --- |
| `launchbox\launchbox.db` | baza LaunchBox Games DB (~180 MB) — opisy gier spoza Steama | nie |
| `prefs.json` (+ `.bak`) | grupy (kategorie) i ich przypięcia, ulubione, wybory grafik | nie |
| `first-seen.json` | data pierwszego pojawienia się gier Steam (sekcja „Nowo dodane”) | nie |
| `settings.json` | ustawienia | nie |
| `secrets.json` | klucze API zaszyfrowane Windows DPAPI (`safeStorage`) | nie |
| `custom-art\` | grafiki wybrane z własnych plików (kopie) | nie |
| `cache\art\` | pobrane grafiki + indeks (także zapamiętane braki) | tak |
| `cache\meta\` | opisy gier ze sklepu Steam (14 dni) | tak |
| `cache\account-library.json` | ostatnia lista gier konta (używana offline) | nie |
| `logs\lumen.log` | log diagnostyczny (klucze są maskowane) | — |

Klucze nigdy nie trafiają do repozytorium ani do logów.

## Sterowanie

| Akcja | Klawiatura | Kontroler (Xbox / standard) |
| --- | --- | --- |
| Nawigacja | strzałki | D-pad / lewa gałka |
| Wybierz | Enter / Spacja | A |
| Wstecz | Esc / Backspace | B |
| Ulubiona | F | X |
| Szukaj | S, `/` lub Ctrl+F | Y |
| Poprzednia / następna zakładka | Q / E | LB / RB |
| Szybkie przewijanie | PgUp / PgDn | LT / RT |
| Ustawienia | O | Start (☰) |
| Filtr instalacji w bibliotece | V | View (⧉) |
| Pełny ekran | F11 | — |

Mysz działa wszędzie. Pola tekstowe przy obsłudze padem otwierają klawiaturę ekranową
(A — wpisz, X — usuń, Y — spacja, LB — wielkie litery, Start — gotowe).

**Steam Input:** jeśli kontroler jednocześnie porusza kursorem myszy (konfiguracja pulpitu Steam),
wyłącz ją w Steam → Ustawienia → Kontroler albo dodaj `Lumen.exe` jako grę spoza Steam
i ustaw dla niej układ „Gamepad”.

## Testy

```bash
npm test
```

```bash
npm run typecheck
```

Zakres testów i checklista testów ręcznych: [docs/TESTING.md](docs/TESTING.md).
Architektura i ograniczenia integracji: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Zmienne środowiskowe (diagnostyka / testy)

| Zmienna | Działanie |
| --- | --- |
| `LUMEN_USER_DATA=<katalog>` | osobny profil danych (np. do testów) |
| `LUMEN_STEAM_PATH=<katalog>` / `none` | wymuszenie ścieżki Steam / symulacja braku Steam |
| `LUMEN_OFFLINE=1` | symulacja braku sieci (każde żądanie HTTP kończy się błędem) |
| `LUMEN_DEBUG=1` | dodatkowe logi na konsoli |
