# Lumen — launcher gier Steam i EmuStart do obsługi z kanapy

> **Lumen + EmuStart:** jedna aplikacja dla gier Steam i gier na emulowane platformy z serwera
> [EmuStart](engine/README.md). Jeden interfejs w dwóch układach: **tryb pulpitu** i **tryb TV**
> (pełnoekranowy, w wyglądzie EmuStart) — te same funkcje, biblioteka, ustawienia, konto i lista zadań;
> przełączanie F10 albo View + Start bez restartu. EmuStart działa w Lumenie tylko jako silnik (bez
> własnego interfejsu). Architektura i stan integracji: [docs/INTEGRATION.md](docs/INTEGRATION.md),
> migracja danych: [docs/MIGRATION.md](docs/MIGRATION.md).

Lumen to lokalna aplikacja desktopowa (Windows) z przejrzystym, ciemnym interfejsem do przeglądania
i uruchamiania gier Steam klawiaturą, myszą lub kontrolerem. Górny pasek to **Start** (ostatnio grane
i nowo dodane), **platformy i grupy** (Steam, kolekcje Steam np. PS2, Ulubione — LB/RB lub Q/E
przełączają) i **Ustawienia**. Każda grupa to pełna siatka plakatów jak w bibliotece Steam z belką
wyszukiwania (Y), filtra instalacji (LT/RT) i sortowania (View); strzałki i gałka poruszają się tylko po grach,
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
- Gry EmuStart: dostęp do serwera EmuStart (EmuStart Server) i konto na nim.
- Do budowania ze źródeł: Node.js 22+ (sprawdzone na 24.16) i npm, Python 3.12+ (sprawdzone na 3.14)
  z pakietami z `engine/requirements.txt` (`pip install -r engine/requirements.txt`; do zbudowania
  silnika także `pip install pyinstaller`).

## Szybki start (ze źródeł)

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` uruchamia aplikację z przeładowaniem na żywo. Silnik EmuStart startuje ze źródeł
(`py -3 engine/engine_main.py`; inny Python: Ustawienia → EmuStart albo zmienna `LUMEN_PYTHON`). Wersja produkcyjna bez serwera deweloperskiego:

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

`npm run dist` buduje najpierw silnik EmuStart (`npm run build:engine` → `engine/dist/EmuStartEngine/`,
PyInstaller), który trafia do `resources\engine\` — wersja zbudowana nie wymaga Pythona.

Wynik w katalogu `release/`:

| Plik | Opis |
| --- | --- |
| `Lumen-<wersja>-win64.zip` | **wersja folderowa (zalecana jako przenośna)**: rozpakuj gdziekolwiek — program i wszystkie dane zostają w tym jednym folderze |
| `Lumen-<wersja>-setup.exe` | instalator (wybór katalogu, skróty w menu Start i na pulpicie); dane w `LumenData\` obok programu, odinstalowanie i aktualizacja ich nie usuwają |
| `Lumen-<wersja>-portable.exe` | pojedynczy plik bez instalacji; dane w `LumenData\` obok pliku, ale sam program rozpakowuje się przy każdym starcie do `%TEMP%` |
| `win-unpacked/Lumen.exe` | rozpakowana aplikacja (szybki podgląd: `npm run dist:dir`) |

Pliki nie są podpisane certyfikatem, więc Windows SmartScreen może przy pierwszym uruchomieniu pokazać ostrzeżenie.

### Aktualizacje (jak w EmuStart)

Lumen sam sprawdza wydania na GitHubie (C4rl0s79/Launcher) — przy starcie i raz dziennie — i pokazuje
„⬆ Nowa wersja” na górnym pasku. Ustawienia → **Aktualizacja Lumen** (albo tryb TV: Menu → „Sprawdź aktualizację Lumen”):
**Pobierz** → **Zainstaluj i uruchom ponownie**. Pobrany plik musi mieć skrót SHA-256 zgodny z wydaniem
**i poprawny podpis wydania Lumen** (Ed25519, `<plik>.sig`, klucz publiczny w programie) — inaczej nic nie jest
instalowane. Podmianę robi skrypt po zamknięciu Lumen (jednorazowe zadanie Harmonogramu „Lumen Update”,
usuwane po pracy): kopia zapasowa, podmiana, przy błędzie powrót do poprzedniej wersji, start nowej.
`LumenData` nie jest ruszany. Przebieg: `LumenData\logs\update.log`.

| Wersja | Co jest pobierane | Podmiana |
| --- | --- | --- |
| ZIP (folder) | `Lumen-<w>-win64.zip` | pliki programu w folderze (kopia w `LumenData\update\backup`) |
| instalator | `Lumen-<w>-setup.exe` | instalator uruchamiany po cichu (`/S`) |
| portable | `Lumen-<w>-portable.exe` | podmiana pliku `.exe` w miejscu (ta sama nazwa i ścieżka) |

Wersje do 0.3.4 nie mają aktualizatora — 0.4.0 trzeba raz pobrać ręcznie.

### Wydanie (podpisy)

```bash
npm run dist
```

```bash
node scripts/sign-release.mjs release/Lumen-<w>-win64.zip release/Lumen-<w>-setup.exe release/Lumen-<w>-portable.exe
```

Klucz prywatny wydań: `D:\GIT\_klucze\launcher-release-ed25519.pem` (albo `LUMEN_SIGNING_KEY_FILE`) — nigdy
w repozytorium; skrypt sprawdza, czy pasuje do klucza publicznego w `src/main/releaseSigning.ts`. Do wydania
na GitHubie trafiają trzy pliki i trzy pliki `.sig`.

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

### Serwer EmuStart (gry na emulowane platformy)

1. Na komputerze z serwerem: panel EmuStart Server → **Dodaj urządzenie** (link logowania / kod QR)
   albo `EmuStartServer.exe --login-link` (link do schowka).
2. W Lumen: **Ustawienia → EmuStart → „Zaloguj do serwera”** (albo w trybie TV: Start → „Zaloguj do
   serwera”) → wklej link → „Mam konto” / „Nowe konto” → nazwa i hasło konta → kod do porównania.
3. Biblioteka przychodzi z serwera; każda platforma pojawia się jako grupa na górnym pasku. Folder
   emulatorów i pobranych gier: Ustawienia → EmuStart. Emulatory i BIOS-y pobierają się z serwera.
4. Istniejąca instalacja EmuStart: Ustawienia → EmuStart → „Folder danych EmuStart” → **Wybierz…** → folder programu
   EmuStart (dane używane na miejscu, bez kopiowania — szczegóły w [docs/MIGRATION.md](docs/MIGRATION.md)).

Gry EmuStart: „Pobierz i graj” / „Graj”, „Pobierz na dysk” (zostaje na stałe), „Usuń z dysku”.
Gra wielopłytowa to jedna pozycja (💿 N — liczba płyt). Wersje regionalne jednej gry to w trybie pulpitu
jeden plakat („N wersji”) — wersję wybierasz w szczegółach gry, a domyślny region w Ustawieniach → EmuStart.
Zapisy synchronizuje EmuStart przez serwer przed i po grze, jak Steam Cloud — przy konflikcie
wybierasz wersję (szczegóły i ograniczenia: [docs/INTEGRATION.md §6](docs/INTEGRATION.md)).
**Wymaga EmuStart Server 0.46.0** — ze starszym serwerem gry działają, ale bez synchronizacji zapisów.
Gry Steam synchronizuje Steam Cloud.

### SteamGridDB (grafiki — opcjonalnie)

1. Zaloguj się na <https://www.steamgriddb.com> i skopiuj klucz z *Preferences → API*
   (<https://www.steamgriddb.com/profile/preferences/api>).
2. W Lumen: **Ustawienia → Grafiki → Klucz SteamGridDB** → wklej → **Zapisz**.
3. Przełącznik „Najpierw grafiki ze SteamGridDB” decyduje, czy domyślnie używać SteamGridDB, czy oficjalnych grafik Steam.
4. W ekranie gry: **Grafiki** — wybór plakatu / tła / logo / ikony, własny plik, „Zmień dopasowanie gry”.

### Gdzie są dane

Wszystkie wersje (instalator, ZIP, portable): folder **`LumenData\` obok programu** — ustawienia, cache,
baza LaunchBox, a w `LumenData\emustart\` pobrane gry (`cache\`), emulatory (`emulators\`, razem
z BIOS-ami z serwera w folderze `system` RetroArcha), profile i logi EmuStart; pliki tymczasowe (rozpakowane
gry, Chromium) w `LumenData\tmp\` zamiast `%TEMP%`. Poza folderem programu nic nie jest zapisywane
(Steam jest tylko odczytywany). Wyjątki: gdy folder programu jest tylko do odczytu (np. `Program Files`),
dane trafiają do `%APPDATA%\Lumen\` (komunikat w logu); klucz urządzenia EmuStart jest w TPM, gdy
komputer go ma. Przy pierwszym starcie dane ze starszej wersji (`%APPDATA%\Lumen\`) są **kopiowane**
do `LumenData\` — oryginał zostaje. Klucze API są szyfrowane dla konta Windows, więc na innym komputerze
trzeba je wpisać ponownie. W trybie deweloperskim (`npm run dev`) dane są w `%APPDATA%\Lumen\`.

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
| `emustart\` | dane silnika EmuStart (config, pobrane gry, profile, `logs\emustart.log`), jeśli nie wskazano innego folderu | nie |
| `emustart-library.json` | ostatnia biblioteka EmuStart (widoczna, gdy silnik nie działa) | nie |

Klucze nigdy nie trafiają do repozytorium ani do logów.

## Sterowanie

| Akcja | Klawiatura | Kontroler (Xbox / standard) |
| --- | --- | --- |
| Nawigacja | strzałki | D-pad / lewa gałka |
| Wybierz | Enter / Spacja | A |
| Wstecz | Esc / Backspace | B |
| Ulubiona | F | X |
| Szukaj | S, `/` lub Ctrl+F | Y |
| Poprzednia / następna grupa (górny pasek) | Q / E | LB / RB |
| Filtr: wszystkie / zainstalowane / niezainstalowane | PgUp / PgDn | LT / RT |
| Ustawienia | O | Start (☰) |
| Sortowanie w grupie | V | View (⧉) |
| Pełny ekran | F11 | — |
| Tryb pulpitu ⇄ tryb TV | F10 | View + Start |

W trybie TV obowiązuje sterowanie EmuStart (A — graj, przytrzymane A — opcje, Y — przypnij / ulubiona
dla gier Steam, X — filtry, Start — menu, A + Y przez 2 s w grze — menu w grze).

Mysz działa wszędzie. Foldery i pliki (dane EmuStart, emulatory, pobrane gry, Python, własne grafiki)
wybiera się we własnej przeglądarce Lumen — samym padem: gałka/D-pad, **A** otwórz, **X** wybierz ten
folder, **B** wyżej (na pierwszej stronie: skróty i dyski). Okno wyboru Windows nie jest używane.
W trybie TV foldery wybiera przeglądarka folderów EmuStart (A na ustawieniu ścieżki).
Pola tekstowe przy obsłudze padem otwierają klawiaturę ekranową
(A — wpisz, X — usuń, Y — spacja, LB — wielkie litery, Start — gotowe).

**Pad:** domyślnie Lumen tylko odczytuje stan padów przez XInput (jak gry) i nie inicjalizuje urządzeń — pady Xbox i widziane jako Xbox (Steam Input, tryb X). Pady PlayStation/Switch bez Steam Input: Ustawienia → Zachowanie → wyłącz „Pad przez XInput” (Gamepad API przeglądarki; może przeszkadzać w podłączaniu pada przy działającym Lumen).

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

```bash
npm run test:engine
```

Serwer testowy EmuStart (tylko 127.0.0.1, plik-atrapa zamiast gry) do testów integracyjnych:
`py -3 scripts/test-server.py .lumen-test/srv` — link logowania w `.lumen-test/srv/login.txt`.

Zakres testów i checklista testów ręcznych: [docs/TESTING.md](docs/TESTING.md).
Architektura i ograniczenia integracji: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Zmienne środowiskowe (diagnostyka / testy)

| Zmienna | Działanie |
| --- | --- |
| `LUMEN_USER_DATA=<katalog>` | osobny profil danych (np. do testów) |
| `LUMEN_STEAM_PATH=<katalog>` / `none` | wymuszenie ścieżki Steam / symulacja braku Steam |
| `LUMEN_OFFLINE=1` | symulacja braku sieci (każde żądanie HTTP kończy się błędem) |
| `LUMEN_DEBUG=1` | dodatkowe logi na konsoli |
| `LUMEN_PYTHON=<python.exe>` | Python dla silnika EmuStart w wersji ze źródeł |
| `LUMEN_DRY_RUN=1` | **tryb testowy**: akcje `steam://` i uruchamianie emulatorów tylko w logu (żadna gra nie startuje) |
| `LUMEN_NO_PAD=1` | **tryb testowy**: ignoruje pady podłączone do komputera (testy automatyczne UI) |
| `LUMEN_UPDATE_FEED=<url>` | **tryb testowy**: lokalne „najnowsze wydanie” zamiast GitHuba (test aktualizatora; podpis nadal wymagany) |
