# Lumen + EmuStart — integracja

Jedna aplikacja kliencka: gry **Steam** i gry na emulowane platformy z **serwera EmuStart** w jednej
bibliotece, z dwoma wyglądami tej samej aplikacji:

- **tryb pulpitu** — wygląd i obsługa Lumen (dawny SteamLaunch),
- **tryb TV (pełnoekranowy)** — wygląd i obsługa EmuStart (karuzela systemów → lista gier z podglądem).

Serwer EmuStart pozostaje osobnym programem (EmuStart Server); jego API (`/v1/…`) nie zmieniło się.

---

## 1. Audyt projektów źródłowych (20.10.2026)

| | SteamLaunch („Lumen”) | EmuStart |
|---|---|---|
| Repozytorium | `D:\GIT\SteamLaunch` (`master`, 128eef8) | `D:\GIT\Emustart` = github.com/C4rl0s79/EmuStart (w `engine/` od 20.10.2026: **`main` v0.46.1**, 8b40316) |
| Stos | Electron 44, React 19, TypeScript, electron-vite, zustand, koffi (XInput) | Python 3.14, pywebview 6 (WebView2), interfejs w czystym JS/HTML/CSS (`web/`), PyInstaller |
| Architektura | proces główny (Steam: pliki VDF/ACF, rejestr, `steam://`, Web API, SteamGridDB, LaunchBox) + renderer React | klient: `Api` (`emustart/api.py`) wołane z UI przez most pywebview (albo `POST /api/<metoda>` w trybie `--browser`); serwer: `server_main.py` (biblioteka, grafiki, konta, urządzenia, emulatory, BIOS-y, zapisy) |
| Testy (stan wyjściowy) | 103 vitest — wszystkie przechodziły, `tsc` bez błędów | 320 pytest — wszystkie przechodziły |
| Licencja | brak pliku licencji, `package.json`: UNLICENSED, autor Carlos | brak pliku licencji, autor C4rl0s79 |

### Co rzeczywiście istnieje

**Steam (Lumen)** — gotowe i sprawdzone wcześniej na sprzęcie: biblioteka z plików Steam (bez logowania),
pełna biblioteka konta przez oficjalne Web API (klucz), uruchamianie i instalacja wyłącznie przez klienta
Steam (`steam://rungameid`, `steam://install`), postęp pobierania tylko z liczników manifestu, kolekcje
Steam (tylko odczyt), skróty spoza Steam, SteamGridDB, LaunchBox, pad przez XInput, wykrywanie końca gry
z `RunningAppID`. Lumen **nie** pobiera plików gier, nie dotyka DRM i nie synchronizuje zapisów Steam
(robi to Steam Cloud).

**EmuStart (klient 0.45.1)** — gotowe: logowanie urządzenia na serwerze (link/QR z panelu, konto + hasło,
klucz urządzenia w TPM/DPAPI), kopia biblioteki serwera do pracy offline (`libsync`), pobieranie gier
z serwera wieloma strumieniami z wznawianiem (`.part` + mapa bloków), granie w trakcie pobierania (WinFsp),
pamięć podręczna „ostatnie N + przypięte”, rozpakowanie ZIP do pamięci, playlisty `.m3u`, emulatory
z magazynu serwera (manifest SHA-256, archiwum wznawiane), BIOS-y z serwera, menu w grze (A+Y),
profile graczy z PIN-em/hasłem, blokada profilu na czas gry, synchronizacja zapisów profilu przez serwer
przed i po grze, kolejka zapisów offline.

**0.46.0 (od 20.10.2026 w `engine/`):** synchronizacja zapisów „jak Steam Cloud” na serwerze, PC
i Androidzie (paczki, rewizje, konflikt rozstrzygany przez gracza) — patrz §6.

### Wybrany wariant integracji

| Wariant | Ocena |
|---|---|
| Przepisanie EmuStart na TypeScript | ~15 tys. linii dojrzałego kodu klienta (pobieranie, emulatory, menu w grze, profile, zapisy) — wysokie ryzyko utraty funkcji, odrzucone |
| Przepisanie Lumen na Python/pywebview | utrata React UI, wirtualizacji, XInput w procesie głównym — odrzucone |
| Dwa programy obok siebie | wprost wykluczone wymaganiami |
| **Lumen (Electron) jako aplikacja i rdzeń + klient EmuStart jako silnik bez okna** | **wybrany**: cała logika emulacji zostaje w sprawdzonym kodzie EmuStart, UI EmuStart (vanilla JS) działa w oknie Electrona bez przepisywania, Steam zostaje w kodzie Lumen |

EmuStart już miał tryb bez własnego okna (`main.py --browser`: to samo `Api` przez `POST /api/<metoda>`)
i most dla Androida (`?android`) — integracja dokłada trzeci, analogiczny most `?lumen`.

---

## 2. Architektura

```
Lumen.exe (Electron, jeden proces aplikacji, jedno okno)
├─ proces główny (src/main) ─────────────── wspólny rdzeń
│   core/unifiedLibrary.ts   jedna biblioteka: Steam + EmuStart (bez łączenia po tytule)
│   core/jobs.ts             jedna lista zadań (pobieranie Steam, uruchamianie/pobieranie/emulatory/zapisy EmuStart)
│   core/uiMode.ts           dwa układy jednego interfejsu (pulpit / TV — pełny ekran, gra przechodzi między nimi)
│   library/, steam/, art/…  integracja Steam (bez zmian funkcjonalnych)
│   emustart/engine.ts       proces silnika: start, handshake, token, restart, wywołania
│   emustart/provider.ts     biblioteka i stan EmuStart z silnika (+ kopia offline)
│   emustart/mapping.ts      model EmuStart → wspólny model `Game`
│   emustart/ipc.ts          akcje EmuStart (gry, opcje gry, zapisy, konto i profile — lista dozwolonych metod)
└─ interfejs (src/renderer, React) ───────── jeden; układ pulpitu (wygląd Lumen) i układ TV
                                              (src/renderer/src/tv, wygląd EmuStart)
        │ IPC
        ▼
EmuStartEngine.exe / py engine/engine_main.py  (silnik bez okna, 127.0.0.1, token sesji)
   emustart/lumen.py  LumenApi = Api EmuStart + zestawienia biblioteki, zadań i opcji gry; urządzenie
                      „Lumen” na serwerze; bez interfejsu (engine/web nie jest używany ani pakowany)
   emustart/*.py      cała logika klienta EmuStart (bez zmian funkcjonalnych)
        │ HTTPS (przypięty certyfikat, klucz urządzenia)
        ▼
EmuStart Server (osobny program, API /v1 bez zmian)
```

### Granice odpowiedzialności

- **Rdzeń** (proces główny): biblioteka, konfiguracja Lumen, kolejka zadań, tryby, decyzja „kto wykonuje
  akcję” dla danego źródła.
- **Integracje źródeł**: Steam — `library/`, `steam/`; EmuStart — `emustart/` (TS) + silnik (Python).
- **Usługi współdzielone**: pobieranie, emulatory, BIOS-y, uruchamianie emulatorów, synchronizacja zapisów
  i cache gier EmuStart są **w silniku** (jedna implementacja); grafiki/metadane Steam, ustawienia, logi —
  w Lumen.
- **Prezentacja**: jeden interfejs (React), dwa układy — każda funkcja napisana raz (np. „Graj”:
  `lib/primary.ts` → `emustart.launch` → silnik `launch`; opcje gry, zapisy, konto, profile, menu w grze —
  te same komponenty w obu układach). Od Lumen 1.0.0 nie ma już osobnego widoku z interfejsem EmuStart.

### Silnik EmuStart (`engine/`)

`engine/` to subtree repozytorium EmuStart (patrz `engine/UPSTREAM.md`). Zmiany względem EmuStart są
małe i opisane w `engine/CHANGELOG.md`:

| Plik | Zmiana | Wpływ na samodzielny EmuStart |
|---|---|---|
| `engine_main.py` (nowy) | start bez okna, handshake na stdout, koniec po zamknięciu stdin | brak |
| `emustart/lumen.py` (nowy) | `LumenApi`: `lumen_library`, `lumen_status`, `lumen_readiness`, konflikty dla obu UI | brak |
| `emustart/paths.py` | katalog danych z `EMUSTART_HOME` | brak (bez zmiennej jak dotąd) |
| `emustart/server.py` | `/api` wymaga `X-Lumen-Token`, gdy ustawiono `ENGINE_TOKEN` | brak (domyślnie pusty) |
| `web/index.html` | CSP: `img-src` także `lumen-art:` | brak |
| `web/app.js`, `web/options.js` | most `?lumen`, system „Steam”, akcje Steam, „Tryb pulpitu”, wybór gry | brak (aktywne tylko z `?lumen`) |
| `lumen-engine.spec` (nowy) | PyInstaller: `EmuStartEngine.exe` bez pywebview | brak |
| `emustart/lumen_discs.py` (nowy), `emustart/launcher.py` | gry wielopłytowe łączone w kopii biblioteki klienta; playlista `.m3u` bez ścieżek `.bin` | brak (włączane tylko przez `LumenApi`; poprawka playlisty działa także samodzielnie) |

Bezpieczeństwo silnika: HTTP tylko na `127.0.0.1`, sprawdzanie nagłówka Host (DNS rebinding — jak
w EmuStart), `X-EmuStart` (bez CORS), a dodatkowo losowy token sesji z procesu Lumen. Token jest
maskowany w logach Lumen. Klucz urządzenia (`server_key`) nie jest przekazywany do widoku pulpitu.

---

## 3. Wspólny model biblioteki

`Game` (`src/shared/types.ts`) — wspólne pola: `id`, `source`, `name`, `sortName`, `installState`,
`installed`, `lastPlayed`, `playtimeMinutes`, ulubione (w preferencjach Lumen), kategorie Lumen. Część
specyficzna dla źródła:

| Źródło | `id` (stabilny) | część specyficzna | instalacja / uruchamianie |
|---|---|---|---|
| Steam | `steam:<appid>` | `appId`, stan z manifestu, postęp z liczników | klient Steam (`steam://`) |
| skrót Steam | `shortcut:<appid32>` | `shortcut` (exe, tagi) | klient Steam |
| EmuStart | `emu:<game_id>` — identyfikator z serwera (`savesync.game_id(system, nazwa)`), taki sam na każdym urządzeniu | `emu`: lokalny numer gry w silniku, system, tagi, rozmiar, `cached`, `pinned`, `copying` | silnik EmuStart |

Stany EmuStart w modelu: `notInstalled` = tylko na serwerze, `installing` = pobieranie w toku,
`installed` = kompletna kopia w pamięci podręcznej gier (gra działa bez serwera).
Gry **nie są łączone po tytule** — wersja Steam i wersja z emulatora to osobne pozycje (test w
`tests/emustart.test.ts`). UI pokazuje tylko akcje danej integracji (np. „Grafiki/SteamGridDB” tylko dla
Steam, „Zachowaj na dysku / Usuń z dysku” tylko dla EmuStart).

Grupy na górnym pasku trybu pulpitu: „Steam” (tylko gry Steam), ulubione, kolekcje Steam, własne
kategorie i **platformy EmuStart** (kategoria `emustart`, tylko do odczytu, nowe przypinane automatycznie,
znikają, gdy znikną z biblioteki serwera; synchronizowane tylko z działającego silnika, nigdy z pustej listy).

---

## 4. Steam — instalacja i uruchamianie

Bez zmian w mechanizmie Lumen: wszystko przez klienta Steam. W trybie TV gry Steam są systemem „Steam”:
A na zainstalowanej grze → `steam://rungameid` (ekran uruchamiania EmuStart śledzi `RunningAppID`;
gdy Steam nie zgłosi gry w 30 s, ekran się zamyka); A na niezainstalowanej → `steam://install` i ekran
„Instalacja przez Steam” (bez udawania postępu — postęp z manifestu na pasku u góry i w oknie Steam);
Y → ulubiona (wspólna z trybem pulpitu); przytrzymane A → akcje Steam (sklep, okno pobierania, …).
Pobierania Steam są na wspólnej liście zadań jako „zarządzane przez Steam”, bez anulowania (Lumen nie
ma takiej możliwości).

## 5. EmuStart — serwer, pobieranie, emulacja

Wszystko robi kod EmuStart w silniku, w obu trybach:

- logowanie, profile, PIN, wybór emulatora dla systemu — ekrany EmuStart (tryb TV → Ustawienia; z trybu
  pulpitu przycisk „Konto, profile i emulatory systemów”),
- „Pobierz i graj” / „Graj” (`launch`): pobieranie (strumienie, wznawianie z `.part`, porównanie rozmiaru
  z serwerem), rozpakowanie, BIOS-y z serwera, start emulatora, czas gry, porządki,
- „Pobierz na dysk / Zachowaj na dysku” (`toggle_pin`), „Usuń z dysku” (`remove_local`),
- brak emulatora: `lumen_readiness` przed startem; pulpit pokazuje „Zainstaluj emulator” (z magazynu
  serwera) albo, gdy serwer go nie udostępnia, „Brak emulatora” z instrukcją; tryb TV — okno EmuStart,
- tylko zasoby skonfigurowanego serwera — integracja nie dodaje żadnych źródeł ROM-ów ani BIOS-ów,
- bez serwera: gry z pamięci podręcznej działają, reszta jest oznaczona „Serwer niedostępny”;
  bez silnika (np. brak Pythona w wersji ze źródeł): Steam działa w obu trybach, lista gier EmuStart
  z ostatniej kopii (`emustart-library.json`), bez uruchamiania.

Anulowanie: pobieranie przy uruchamianiu — „Anuluj” (część zostaje do wznowienia); pobieranie gry
zachowywanej — odepnij (część zostaje); pobieranie w tle po starcie — usunięcie kopii; instalacja
emulatorów — „Anuluj”. Rozpakowywanie archiwów i ścieżki docelowe — mechanizmy EmuStart (`cache.py`,
`installer.py`: manifest SHA-256, rozpakowanie tylko plików z manifestu).

## 6. Synchronizacja zapisów — stan faktyczny (EmuStart 0.46.0)

Lumen **nie dodaje** własnej synchronizacji — używa klienta EmuStart 0.46.0 (`syncclient.py`,
`savebundles.py`, `launcher.py`), czyli synchronizacji „jak Steam Cloud”:

- serwer jest jedynym źródłem prawdy; zapisy w grze, stany i karty pamięci synchronizują się
  **paczkami** per konto, gra, emulator i rdzeń RetroArcha (RetroArch: zapisy i stany; DuckStation
  i PCSX2: karta pamięci osobna dla gry),
- przed grą pobierają się zmiany z innych urządzeń, po grze zmiany idą na serwer; bez połączenia gra
  rusza na zapisach z urządzenia, a zmiany wysyłają się, gdy serwer wróci (zadanie „Wysyłanie zapisów”),
- **konflikt** (zapisy zmienione tu i na innym urządzeniu): uruchamianie zatrzymuje się i czeka na
  decyzję gracza — w trybie TV okno EmuStart, w trybie pulpitu okno Lumen z obiema wersjami (kiedy,
  z którego urządzenia) i wyborem **Zostaw z tego urządzenia / Weź z serwera / Pomiń** (pad: X / Y / B,
  wywołanie `launch_choice`). Druga wersja zostaje w historii na serwerze (10 ostatnich) albo w kopii
  zapasowej na urządzeniu,
- stan zapisów gry („zsynchronizowane / czekają na wysłanie / jeszcze nie synchronizowane”) jest
  w szczegółach gry (pulpit) i w opcjach gry (TV); w trybie pulpitu przycisk **„Zapisy”** w szczegółach
  gry otwiera okno z tym stanem, stanami gry na tym komputerze (obrazek, data, „Graj od tego stanu” —
  `game_options` i `launch(id, stan)` silnika, jak „Wczytaj zapis” w trybie TV) i — dla PS2 — stanami
  komputera i telefonu z kopiowaniem między nimi (`save_manager` / `save_copy`, tylko przez serwer),
- **wymaga EmuStart Server 0.46.0** — starszy serwer nie ma API zapisów: gra rusza wtedy na zapisach
  z urządzenia, bez synchronizacji,
- poza paczkami (stany PS2 `.p2s`, Dolphin, PPSSPP, RPCS3) — jak dotąd: folder profilu na serwerze,
  blokada profilu na czas gry, przy konflikcie zostaje nowsza wersja, druga w kopii zapasowej profilu
  (te konflikty pokazuje panel zadań trybu pulpitu i komunikat w trybie TV),
- koniec sesji = koniec procesu emulatora (`proc.wait()`); emulatory uruchamiane przez proces pośredni
  nie są osobno obsługiwane — **niesprawdzone**.

### 6.0. Zapisy jak Steam Cloud — EmuStart 0.47 / 0.48 (Lumen 0.5.0)

Wszystko poniżej robi kod EmuStart (silnik Lumena = EmuStart 0.48.3); Lumen niczego tu nie dokłada poza
oknem „Zapisy” i „Przejmij profil” w trybie pulpitu. **Wymaga EmuStart Server 0.48.0.**
- **jeden zestaw zapisów na konto i grę**: zapisy w grze wspólne dla zgodnych rdzeni (SNES: Snes9x,
  bsnes, Mesen-S; NES: FCEUmm, Nestopia, Mesen, QuickNES), stany per rdzeń — „Wczytaj zapis” i okno
  „Zapisy” pokazują też stany innych rdzeni z oznaczeniem „✗ … nie wczyta się”;
- **zapisy sprzed 0.46** przenosi migracja na serwerze — **nie uruchamia się sama**: panel serwera →
  Konfiguracja → „Zapisy sprzed 0.46” → Sprawdź, potem Przenieś zapisy (istniejące paczki nie są
  nadpisywane, stara wersja idzie do historii);
- **jedna gra naraz na profil**: atomowa blokada na serwerze (`/v1/lock/…`, urządzenie z tokenu
  sesji); kolejność blokada → pobranie → gra → wysłanie → zdjęcie; w trybie pulpitu „Profil gra
  teraz na urządzeniu …” → **Przejmij profil i graj** (X) albo Zamknij;
- **przed wylogowaniem** wysłanie zaległych zapisów (zostały — pytanie), **po zalogowaniu i przy
  starcie** pobranie nowszych wersji znanych paczek;
- **rejestracje per program**: serwer zastępuje tylko rejestrację tego samego programu na sprzęcie;
  Lumen wysyła `app: "Lumen"` (`lumen.install_device_identity`) i dalej własny skrót sprzętu.
- **EmuStart 0.48.2 / 0.48.3** (silnik Lumena od 26.10.2026, bez zmian w Lumenie — metody silnika te same):
  stany PS2 jedną paczką `pcsx2/states` wspólną dla PCSX2 (PC) i ArmSX2 (telefon), stany z dwóch
  urządzeń się sumują; „Wczytaj zapis” w RetroArchu nie nadpisuje następnego stanu (stan jako
  autozapis przy starcie); ustawienia zmienione w samym emulatorze (np. przypisania pada) przejmowane
  do profilu, który grał ostatnio — w historii ustawień emulatora („Opcje gry → Ustawienia emulatora”)
  jako „zmiany w emulatorze poza EmuStart”; DuckStation / PCSX2 po grze przywracają tylko numer pada.
- **EmuStart 0.49.0** (Lumen 1.0.13, 27.10.2026): logowanie kodem logowania ze strony serwera
  (link / kod QR albo adres + 8 znaków; `server_enroll(tekst, "code", "", "", kod)`) albo „Mam konto i
  hasło” (`"existing"`). Nowego konta nie zakłada się w aplikacji — zaproszenie (strona serwera) albo
  panel; usunięte metody silnika `account_request` / `account_requests_poll`, `profile_create` bez
  hasła (tylko profil lokalny bez serwera). **Wymaga EmuStart Server 0.49.0.**
- **EmuStart 0.49.1** (Lumen 1.0.15, 28.10.2026): poprawka strony serwera („Wyloguj” bez błędu 501); klient bez zmian.

### 6.1. Rozjazd zapisów między Lumenem, EmuStart i telefonem — diagnoza (20.10.2026)

Na prawdziwej bibliotece (Chrono Trigger MSU-1) każdy program widział inne zapisy. Przyczyny z logów:

1. **Wzajemne wylogowywanie na jednym komputerze.** Serwer trzyma jedną rejestrację na sprzęt
   (`devices.replace_same_hw`); Lumen i samodzielny EmuStart wysyłały ten sam skrót sprzętu, więc
   zalogowanie jednego unieważniało drugiego (EmuStart: „nieznane urządzenie”, 401; potem odwrotnie).
   **Naprawione w Lumen 0.4.3**: Lumen to osobne urządzenie (skrót sprzętu + „lumen”,
   `lumen.install_device_identity`); po aktualizacji Lumen trzeba raz zalogować ponownie.
   **Lumen 0.4.4** — także nazwa urządzenia „<komputer> (Lumen)” (`lumen.install_device_name`) tam,
   gdzie EmuStart rozpoznaje urządzenie po nazwie komputera: blokada profilu na czas gry (inaczej
   Lumen brał blokadę samodzielnego EmuStart z tego komputera za własną), nazwa przy logowaniu (panel,
   „z którego urządzenia” w konflikcie zapisów), znaczniki synchronizacji, kopie zapasowe.
   Przegląd pozostałych wspólnych zasobów: klucze TPM — osobne (losowe nazwy), dane, emulatory, TEMP —
   w `LumenData`, dysk strumieniowy — wolna litera, aktualizator EmuStart — wyłączony (menu „Aktualizuj
   Lumen”); Xenia instalowana bez `portable.txt` (katalog emulatorów serwera) używa `Dokumenty\Xenia`
   jak każda Xenia na tym komputerze.
2. **Stare zapisy (EmuStart ≤ 0.45) nie przeszły do paczek 0.46.** 0.45 trzymało zapisy w folderze
   profilu na serwerze (`<profil>/save/retroarch/…`, stany `<profil>/states/shared/retroarch/<rdzeń>/…`);
   0.46 synchronizuje RetroArch tylko paczkami (`savesync`) i pomija te foldery — nikt (serwer, PC,
   telefon) ich nie przenosi. Lumen (0.46) przy pierwszej grze nie miał czego pobrać (serwer: brak
   paczki → `rev 1` wysłana z Lumena). **Do zrobienia w EmuStart Server** (jedna migracja dla wszystkich
   programów) — prompt w rozmowie z 20.10.2026.
3. **Paczka per rdzeń.** Klucz paczki: gra + emulator + rdzeń + rodzaj — bsnes na PC i Snes9x na
   telefonie to osobne zapisy. Wybór rdzenia idzie z kontem tylko Windows↔Windows (0.46.1). **Do
   decyzji w EmuStart** (zapisy w grze wspólne dla zgodnych rdzeni, stany per rdzeń).
4. Samodzielny EmuStart był do 20.10 14:29 w wersji 0.45.1 (synchronizacja folderami, bez paczek).

Tryb pulpitu i tryb TV Lumena to ten sam silnik i ta sama synchronizacja — różnica była między
programami (Lumen ↔ samodzielny EmuStart ↔ telefon), nie między widokami.

## 6a. Dane w folderze programu

Wersje zbudowane trzymają wszystko w `LumenData\` obok `Lumen.exe` (`src/main/dataDir.ts`): dane Lumen,
silnik EmuStart (`LumenData\emustart\`: config, pobrane gry, domyślny folder emulatorów `emulators\`
z BIOS-ami w `system` RetroArcha — EmuStart instaluje emulatory w trybie portable, więc ich ustawienia
i zapisy też są w ich folderach), pliki tymczasowe Chromium i silnika (`TEMP`/`TMP` = `LumenData\tmp\`,
także rozpakowane gry). Instalator nie usuwa `LumenData\` przy odinstalowaniu ani aktualizacji
(`resources/installer.nsh`). Wyjątki: folder programu tylko do odczytu → `%APPDATA%\Lumen\`; klucz
urządzenia w TPM; emulator wskazany ręcznie spoza folderu (np. zwykła instalacja PCSX2 z danymi
w `Documents`); wersja `portable.exe` rozpakowuje sam program do `%TEMP%` (dlatego jest wersja ZIP).

## 6c. Gry wielopłytowe

Jedna pozycja na grę. Serwer EmuStart (bez zmian) łączy `.m3u` i płyty różniące się samym numerem
(„(Disc 1)”, „(Disc 2)”). Pozostałe komplety łączy **Launcher** w swojej kopii biblioteki po każdej
synchronizacji (`emustart/lumen_discs.py`): płyty z literą („(Disc A)”), z podtytułem po numerze
(„(Disc 1) (GDI)”), płyty `.iso` obok gier-katalogów (Xbox 360). Pierwsza płyta staje się grą z plikami
całego kompletu, pozostałe są ukryte (nie usunięte — ich numery i pobrane pliki zostają); nazwa gry
i identyfikator zapisów to te pierwszej płyty, więc zgadzają się z innymi urządzeniami. Płyty, których
serwer nie zwraca dla pierwszej, są szukane na serwerze osobno. Uruchomienie: EmuStart pobiera
wszystkie płyty i tworzy playlistę `.m3u` (same płyty, bez ścieżek `.bin`). Na przykładowej
bibliotece: 36 płyt → 18 gier.
Liczba płyt: ikona 💿 N na plakacie (pulpit) i przy grze na liście (TV), „Płyty” w szczegółach.
Wersje regionalne (Europe / Japan / USA…) to osobne gry na serwerze — łączy je dopiero widok pulpitu (§6d).

## 6d. Wersje regionalne — jedna pozycja w trybie pulpitu

Wydania jednej gry na tej samej platformie — **ten sam tytuł albo ten sam identyfikator LaunchBox**
(`lb_id` z metadanych serwera; łączy też wydania o innych tytułach: „Daedalus Encounter” / „…Episode 1 -
Nanpasen no Alien”, „D” / „D no Shokutaku”, „Ghosts'n Goblins” / „Makaimura”) — są w trybie pulpitu
**jednym plakatem** z odznaką „N wersji” (`main/emustart/versions.ts`). Okładka: wersji pokazywanej, a gdy
jej nie ma — dowolnej innej wersji. Grafiki z silnika są pobierane z limitem (6 naraz) i trzymane w pamięci
— siatka setek plakatów przekraczała limit zapytań Chromium (`ERR_INSUFFICIENT_RESOURCES`). Pozycja pokazuje
i uruchamia jedną wersję: wybraną przez gracza w szczegółach gry (zapamiętaną w `prefs.json` → `versions`),
a bez wyboru — ostatnio graną, potem pobraną, potem wg preferowanego regionu (Ustawienia → EmuStart:
Polska/Europa, USA, Japonia); wersje beta/demo/nielicencjonowane nigdy nie są domyślne. Gry z jedną wersją
mają dotychczasowe id (`emu:<game_id>`), grupy — `emugrp:<skrót>`. Tryb TV zostaje jak w EmuStart: każda
wersja osobno, z regionem przy nazwie. Wyjątek: dema Amigi (`amigawhddemos`) — ten sam tytuł to różne
produkcje, więc nie są łączone. Na przykładowej bibliotece: 41 712 pozycji → 33 931 w trybie pulpitu.

## 6b. Wybór folderów i plików — tylko padem

Żadne ustawienie nie wymaga wpisywania ścieżki ani okna wyboru Windows (wymaga myszy). Tryb pulpitu:
`modals/PathPicker.tsx` + `pickPath()` (store) + `app.listDir` (`main/fsBrowse.ts`, tylko odczyt nazw:
skróty, dyski z etykietami, foldery, pliki z dozwolonymi rozszerzeniami). Wybór jest sprawdzany
w procesie głównym (`emustart.setFolder`, `art.useFile`). Tryb TV: przeglądarka folderów EmuStart
(`folderBrowse`); opcja „Okno Windows (mysz)” EmuStart jest w Lumen ukryta, a `pick_folder` zwraca pusty
wynik.

## 6f. Jedne ustawienia EmuStart dla obu trybów

Ustawienia biblioteki EmuStart (ukrywanie wersji beta/demo/pirackich/nielicencjonowanych/programów i klonów
arcade, pamięć podręczna gier, granie w trakcie pobierania, profile, emulator i włączenie każdego systemu)
są w trybie pulpitu w Ustawieniach → „Biblioteka EmuStart” i w trybie TV w ustawieniach EmuStart — to te same
wartości (`save_settings` silnika, per profil tam, gdzie EmuStart trzyma je per profil). Zmiana w jednym
trybie odświeża bibliotekę i ekran drugiego od razu. W trybie TV zostaje tylko to, czego pulpit nie ma:
logowanie do serwera, konta i PIN-y.

## 6g. Plakaty gier EmuStart

Serwer EmuStart trzyma prawdziwe okładki pudełek (3DO: pudełko „longbox” ~1:2, pudełko CD ~1:1, kartridże
poziomo), a nie plakaty 2:3, więc w siatce trybu pulpitu były przycinane. Teraz:
- **plakat, tło i ikona**: najpierw wybór gracza („Grafiki” w szczegółach gry — także dla gier EmuStart),
  potem SteamGridDB (gdy jest klucz; plakaty 600×900) dopasowany **dokładnie po tytule** — nazwa
  z LaunchBox (po `lb_id` z metadanych serwera, z lokalnej bazy LaunchBox, jeśli jest pobrana) i tytuły
  wszystkich wersji gry; luźne dopasowanie („D” → „D-Day”) jest wyłączone. Wynik (także brak) jest
  pamiętany w pamięci grafik. Pierwsze wyszukanie może trwać — po 2,5 s pokazuje się okładka z serwera,
  a plakat podmienia się, gdy dojdzie;
- **logo**: najpierw z serwera (Clear Logo z LaunchBox), potem SteamGridDB;
- okładka, która nie ma proporcji 2:3 (gdy SteamGridDB nic nie ma), jest pokazana **w całości** na
  rozmytym tle z tej samej okładki, zamiast przycięta;
- „Grafika z serwera EmuStart” w oknie „Grafiki” wraca do okładki z serwera dla danej gry.

**Grafiki z LaunchBox Games DB** (od 0.4.3): lokalna baza LaunchBox (Ustawienia → Grafiki i opisy → Opisy gier spoza
Steama) trzyma listę grafik gier (`images`: pudełka wg regionu, tła „Fanart - Background”, zrzuty, logo,
bannery, kartridże; ~1 mln wpisów, baza ~270 MB); baza zbudowana przez starszy Lumen przebudowuje się
sama raz w tle. Gry EmuStart są dopasowane po `lb_id` z metadanych serwera (bez zgadywania po tytule),
obrazki pobierają się z images.launchbox-app.com dopiero przy wyświetleniu (i zostają w pamięci grafik):
- **tło**: wybór gracza → SteamGridDB → LaunchBox „Fanart - Background” → zrzut z serwera → zrzut z LaunchBox;
- **plakat**: wybór gracza → SteamGridDB → okładka z serwera → „Box - Front” z LaunchBox (region wersji
  pokazywanej, potem preferencja regionu);
- **logo**: z serwera → LaunchBox → SteamGridDB;
- okno „Grafiki” ma sekcję **LaunchBox Games DB** z grafikami tego rodzaju do wyboru (padem).

LaunchBox nie ma plakatów 2:3 — pudełka mają kształt pudełek (te same, które ma serwer).

## 6e. Aktualizacja programu (jak EmuStart)

`src/main/updater.ts` + `releaseSigning.ts`, ten sam przebieg co `emustart/updater.py`: najnowsze wydanie
z GitHuba → plik dla tej wersji programu (ZIP / instalator / portable) → pobranie z postępem → rozmiar,
SHA-256 z GitHuba i podpis Ed25519 (`<plik>.sig`, wiadomość `lumen-release-v1\n<nazwa>\n<sha256>`; klucz
publiczny w programie, prywatny poza repozytorium) → ZIP rozpakowany z kontrolą ścieżek → skrypt
PowerShell po zamknięciu Lumen (kopia zapasowa, podmiana bez `LumenData`, przywrócenie przy błędzie,
restart). Skrypt startuje jako jednorazowe zadanie Harmonogramu „Lumen Update” (proces potomny ginął razem
z Lumen w obiekcie zadania — EmuStart rozwiązuje to `CREATE_BREAKAWAY_FROM_JOB`, niedostępnym w Node).
Silnik EmuStart jest częścią Lumen i aktualizuje się razem z nim („Aktualizuj EmuStart” w trybie TV
uruchamia aktualizację Lumen).

Sprawdzone 20.10.2026 na lokalnym kanale wydań (`LUMEN_UPDATE_FEED`, podpisy prawdziwym kluczem): ZIP
0.3.90 → 0.3.91 i portable 0.3.90 → 0.3.91 — pobranie, weryfikacja, podmiana, restart nowej wersji
z działającym silnikiem, zadanie usunięte. Instalator (`/S`) — niesprawdzony (wymaga instalacji w systemie).

## 7. Tryby interfejsu

Od Lumen 0.6.0 (plan: `docs/PLAN-TV-REACT.md`, etap 1) — **jeden interfejs, dwa układy**:
- **pulpit** i **TV** to ten sam renderer React (`src/renderer`), ta sama biblioteka, akcje i okna
  (uruchamianie, konflikt zapisów, profil na innym urządzeniu, szczegóły, zadania). Układ TV
  (`src/renderer/src/tv/`) ma wygląd EmuStart: karuzela systemów (logo z serwera, opis platformy z
  silnika), lista gier (okładka | szczegóły | zrzut, opis), Steam jako system, menu Start,
  wyszukiwanie klawiaturą ekranową. Akcja „Graj / Pobierz i graj / Zainstaluj emulator” — wspólna
  (`lib/primary.ts`). Pad: A graj, X opcje gry (szczegóły), Y szukaj, LB/RB strona, LT/RT litera,
  B wstecz, Start menu.
- Przełączenie: F10, View + Start, przycisk „⛶ Tryb TV”, menu TV → „Tryb pulpitu”. Zaznaczona gra
  przechodzi między układami (pulpit → TV: jej system i gra; TV → pulpit: jej szczegóły).
- **Konto i profile** (Lumen 0.8.0) — w interfejsie Lumen, oba układy, przepływy EmuStart 1:1
  (`lib/account.ts`, `components/Profiles.tsx`, `components/Dialogs.tsx`; silnik: `api.account` —
  lista dozwolonych metod w `ipc.ts`): logowanie (adres albo link z panelu → mam konto / nowe konto →
  nazwa → hasło z wymaganiami serwera → kod i czekanie na zatwierdzenie), wylogowanie z wysłaniem
  zapisów (niewysłane — pytanie), zatwierdzanie próśb innych urządzeń (przy starcie i co minutę),
  prośby o konto, „Kto gra?” (nowy komputer, pytanie przy starcie, menu „Zmień profil”, Ustawienia →
  Profile, profil zablokowany przy uruchomieniu gry): wybór, nowy profil / inny użytkownik, zmiana
  nazwy, usuwanie, hasło konta, PIN tego urządzenia, profil tego komputera, RetroAchievements
  (logowanie, hardcore, import konta z emulatora). Tekst — klawiatura ekranowa (pad) albo klawiatura
  (Enter zatwierdza).
- Od Lumen 1.0.0 nie ma osobnego widoku z interfejsem EmuStart (usunięte: `WebContentsView`, most
  `fullscreenBridge`, preload `emu`, protokół `lumen-emu://`; `engine/web` = wersja EmuStart, nie pakowana).
- **Lista gier w układzie TV** (Lumen 1.0.1): X — filtry EmuStart (`tv/TvFilters.tsx`, logika w
  `tv/filters.ts`: szukaj w tytule, gatunek, dekada, gracze, region z nazwy, producent, co pokazać,
  sortowanie; zapamiętane dla każdego systemu w `localStorage`; Steam — tylko szukaj, co pokazać i
  sortowanie bez roku), Y — opcje gry (Steam: szczegóły), L3 / Z — szukaj, R3 / U — ulubiona.
- **Szczegóły i oceny** (lista TV — pasek na dole: logo z lewej, szczegóły obok):
  - LaunchBox (baza w schemacie 3, przebudowuje się sama): ocena społeczności i liczba głosów, ESRB,
    kooperacja, typ wydania, maks. liczba graczy;
  - Steam: Metacritic, kooperacja (kategorie sklepu), PEGI / ESRB z `appdetails`; recenzje graczy
    (% pozytywnych) z `appreviews`, a gdy sklep przekierowuje (niektóre regiony) — z SteamSpy;
    format danych `GameDetails.version` = 3 (starszy cache pobierany ponownie);
  - EmuStart: system, liczba uruchomień, emulator, zapisy (stany + synchronizacja), ile gry na dysku
    (`gameOptions` po zatrzymaniu się na grze).
  - Sortowanie (filtry TV i pulpitu): ocena LaunchBox, krytyków (Metacritic), graczy (recenzje Steam);
    gry bez oceny na końcu. Oceny całej listy: `library.ratings` (LaunchBox z lokalnej bazy; Steam z cache,
    brakujące pobierane w tle — lista pyta ponownie co 20 s).
- **Grafiki trybu TV osobno od trybu pulpitu** (Lumen 1.0.9): tryb TV pokazuje okładkę w całości, okienko
  zrzutu i logo — inaczej niż plakat 2:3 i szerokie tło pulpitu, więc ma własne wybory (`prefs.artTv`,
  `ops.setArt(…, 'tv')`) i własny adres obrazka (`lumen-art://…?tv=1`, `tvArt` w `main/index.ts`).
  Domyślnie dla gier EmuStart najpierw LaunchBox (Box - Front; Fanart - Background, potem zrzut; Clear Logo),
  potem grafika serwera; „Grafika z serwera EmuStart” — tylko serwer. Bez własnej grafiki TV (gry Steam,
  gry EmuStart bez LaunchBox i serwera) — jak na pulpicie. Okno grafik otwarte w trybie TV zmienia
  tylko grafiki TV („Grafiki trybu TV”: Okładka, Zrzut / tło, Logo).
- **Lumen 1.0.5:**
  - filtry z układu TV także w grupach trybu pulpitu (X / F, zapamiętane dla każdej grupy; ulubiona — R3 / U);
  - gry EmuStart bez numeru LaunchBox z serwera (Mega Drive, Game Boy, Atari…) są szukane po tytule na
    platformie systemu w lokalnej bazie LaunchBox (`platformForEs`): szczegóły uzupełniane z LaunchBox,
    grafiki LaunchBox (logo, okładka, tło) jak dla gier z numerem;
  - „Tytuły gier jako logo” jak w EmuStart: logo zamiast tytułu na liście gier TV i w nagłówku podglądu
    (tytuł widać, dopóki logo się nie wczyta);
  - opcje gry: „Wersja regionalna” dla gier z kilkoma wersjami (także w układzie TV);
  - okno grafik: LB/RB — rodzaj grafiki, LT/RT — wielkość miniatur; grafika wybrana na serwerze
    (np. z libretro) od razu staje się wyświetlaną na tym urządzeniu (zamiast automatycznej ze SteamGridDB);
  - lista gier TV ma stałą szerokość niezależnie od podglądu.
- **Ustawienia w dwóch panelach** (oba układy, `screens/Settings.tsx`): po lewej lista działów
  (Interfejs, Steam, EmuStart, Biblioteka EmuStart, Systemy, Grupy, Grafiki i opisy, Zachowanie, Dane,
  Aktualizacja, Sterowanie), po prawej wybrany dział, przewijany osobno. Ruch po liście pokazuje dział;
  w prawo / A — do działu, B albo w lewo przy krawędzi — z powrotem na jego pozycję listy.
- **Opcje gry** (Lumen 0.7.0, `components/GameOptions.tsx`) — jedno okno dla obu układów (TV: Y na
  grze EmuStart, od 1.0.1; pulpit: szczegóły → „Opcje gry”), strony jak w EmuStart: Graj / Graj od początku,
  wersja (tłumaczenie, `set_variant` — uruchamia się wybrana wersja: `lumen_play_id`), emulator dla
  gry albo systemu, ustawienia emulatora (zmiana w emulatorze bez gry, shader, historia zmian i
  przywracanie), zapisy, metadane i opis (administrator serwera: edycja, „Przywróć dane pobrane”,
  „Pobierz opis z sieci”), grafiki (administrator: okładka / zrzut / logo na serwerze — dla wszystkich
  urządzeń), ulubiona, zachowaj / usuń z dysku. Dane: `lumen_game_options` (jedno wywołanie).
- Fokus klawiatury i pada zawsze w widocznym interfejsie (ukryty widok EmuStart oddaje fokus).
- **Menu w grze** (Lumen 0.9.0, `components/InGameMenu.tsx`, oba układy): silnik wykrywa A + Y nad
  emulatorem, wyciąga okno Lumen na wierzch i otwiera menu (`ingame_poll` co 80 ms w trakcie gry):
  wróć do gry, zapisz / wczytaj stan, reset, quicksave i wyjdź, shader, wyjdź z gry (pozycje, których
  emulator nie obsługuje — wyszarzone). Wejście: Lumen z fokusem — własny pad i klawiatura; bez fokusu
  — naciśnięcia odczytane przez silnik (żeby nie liczyć ich dwa razy).
- **Reszta ustawień EmuStart** (Lumen 0.10.0): Ustawienia → EmuStart — „Wykryj emulatory” (`autodetect`),
  „Pobierz brakujące emulatory” (`install_missing` → potwierdzenie → zadanie z postępem), administrator:
  „Wyślij klucze źródeł grafik na serwer” (`art_keys_push`); Biblioteka EmuStart → Tryb TV → „Tytuły gier
  jako logo”; układ TV: **X na systemie = Opcje systemu** (`components/SystemOptions.tsx`: emulator
  systemu, pobierz emulator, ukryj system; administrator: logo z serwera, poświata, nazwa). Bez zmian
  (decyzja 20.10): lokalne foldery z grami (edytor wyglądu — niżej, od 24.10).
- **Edytor wyglądu trybu TV** (24.10.2026, `tv/look.ts`, `tv/TvLook.tsx`; wzór: `engine/web/look.js`):
  Menu (Start) → „Wygląd”. Panel z boku nad żywym układem — każda zmiana widoczna od razu; A przełącza
  podgląd systemy ↔ gry, Y przesuwa panel na drugą stronę. Te same ustawienia, zakresy i wartości
  domyślne co w EmuStart (test `tests/look.test.ts` porównuje je z `look.js`): logo tytułu (wysokość,
  szerokość), logo systemu w karuzeli i odstęp, logo nad listą, wysokość wiersza listy, szerokość listy,
  wysokość okładki i zrzutu, wysokość wiersza menu, liczba linii opisu, 10 wielkości czcionek, kolor
  akcentu, tło; do tego „Tytuły gier jako logo” i „Wygląd zapisywany” (dla profilu / dla tego komputera —
  `look_scope` przez `save_settings`). Sterowanie: ↑↓ pozycja, ←→ zmiana, LB/RB ×5, X domyślna, Start
  dwa razy — wszystko domyślne, B zapisz (klawiatura: strzałki, Q/E, F, S, O, Esc; mysz: −/+, ◀/▶, kółko).
  Wartości trafiają do zmiennych CSS ramki `.tv` (`--tv-list-w`, `--tv-row`, `--tv-media-h`,
  `--tv-car-h/-w`, `--tv-fs*`, `--tv-accent`, `--tv-bg`…; `tv.css`), odstęp karuzeli — do `TvSystems`.
  **Zapis tam, gdzie EmuStart:** `look_save` silnika (dopisany do białej listy `ACCOUNT` w
  `emustart/ipc.ts`) → `config.json` → `look`, a przy `look_scope = profile` także ustawienia profilu
  (`emustart.json`), więc wygląd idzie z profilem jak w EmuStart. Odczyt: `get_state().look` przy starcie
  silnika i po zmianie profilu. Bez zmian w repo EmuStart. Bez działającego silnika zmiany działają do
  zamknięcia okna, zapis się nie udaje (komunikat).
- **Kolejność padów** (`components/PadsOrder.tsx`, menu TV i Ustawienia → EmuStart): jak w Windows /
  bezprzewodowe przed przewodowymi / ręcznie (każdy gracz naciska A na swoim padzie, B kończy) —
  kolejność stosuje silnik przy starcie gry (`pads_state` / `pads_set`).

## 8. Co sprawdzono, a co nie (20.10.2026)

**Zaimplementowane i sprawdzone (automatycznie lub ręcznie na tym komputerze):**
- testy: Lumen 123 vitest (103 dotychczasowe + 20 nowych), EmuStart 326 pytest (320 + 6 nowych), `tsc`;
- start aplikacji ze źródeł i spakowanej (`release/win-unpacked/Lumen.exe` z `EmuStartEngine.exe`):
  silnik gotowy w ~1 s, token wymagany (403 bez tokenu);
- z lokalnym serwerem testowym (`scripts/test-server.py`, tylko 127.0.0.1, plik-atrapa): logowanie
  urządzenia kodem z panelu, kopia biblioteki, gra w bibliotece pulpitu i w trybie TV, automatyczna
  grupa platformy, „Pobierz na dysk” → plik w pamięci podręcznej, „Usuń z dysku”, ponowne pobranie,
  spójny stan w obu trybach, „Brak emulatora” z właściwym komunikatem;
- tryb TV: system „Steam” (66 zainstalowanych gier z prawdziwej biblioteki), lista z grafikami Steam,
  opis ze sklepu, przełączanie trybów w obie strony z zachowaniem zaznaczonej gry, brak restartu;
- uruchomienie gry Steam z trybu TV — **przypadkowo** sprawdzone na prawdziwym Steam (patrz §9).

**Zaimplementowane, niesprawdzone w realnym środowisku:**
- uruchomienie gry EmuStart z emulatorem (test serwera nie miał emulatorów — testy z `LUMEN_DRY_RUN`),
- instalacja emulatora z magazynu serwera, BIOS-y, menu w grze A+Y nad emulatorem wyciągające okno Lumen,
- synchronizacja zapisów 0.46.0 przed/po grze i prawdziwy konflikt na serwerze (okno konfliktu w trybie
  pulpitu sprawdzone tylko na danych podstawionych w procesie głównym; logika — testy EmuStart `test_syncclient`),
- pełna obsługa padem w trybie TV (testy automatyczne z `LUMEN_NO_PAD`),
- użycie istniejącego folderu danych EmuStart (`emustartHome`),
- instalator NSIS (zbudowano tylko `--dir`).

**Niewdrożone / ograniczenia:**
- pauza pobierania (EmuStart ma tylko anuluj + wznowienie od miejsca przerwania),
- logowanie do serwera, konta i PIN-y są tylko w trybie TV (ustawienia biblioteki i systemów — w obu, §6f),
- weryfikacja integralności gier: zgodność rozmiaru z serwerem (EmuStart); emulatory: SHA-256 z manifestu,
- kontrola Steam ograniczona do `steam://` (bez postępu na żywo, pauzy, anulowania — jak w Lumen).

## 9. Incydent podczas testów

Przy pierwszym ręcznym teście trybu TV (bez `LUMEN_DRY_RUN`) Lumen wysłał
`steam://rungameid/798460` i Steam uruchomił grę. Polecenie nie pochodziło ze skryptu testowego —
do okna trafiały naciśnięcia z podłączonego pada (XInput, gniazdo 0). Od tej pory testy automatyczne
używają `LUMEN_DRY_RUN=1` (akcje Steam i uruchamianie emulatorów tylko w logu) i `LUMEN_NO_PAD=1`.

### 9.1. Prośba o konto wysłana na prawdziwy serwer (20.10.2026, etap 3)

Podczas automatycznego testu logowania w interfejsie Lumen (etap 3) pole adresu serwera miało
wpisany domyślny adres EmuStart (`emustart.emucloud.org`). Wpisywanie linku testowego nie zadziałało
(zdarzenia klawiszy wysłane na `window` zamiast do elementu z fokusem), a kolejne kroki przeszły — do
**prawdziwego serwera** poszła prośba o **nowe konto „lumenetap3”** (hasło testowe) z kluczem urządzenia
tego komputera. Konto nie powstało: prośba czeka na zatwierdzenie administratora i wygasa 21.10.2026
22:39 UTC — **należy ją odrzucić w panelu serwera** (Urządzenia → prośby). Lokalnie: prośba usunięta z
danych testowych, klucz `EmuStart-66fadc96a272` usunięty z TPM (sprawdzone). Zabezpieczenie: w trybie
testowym (`LUMEN_DRY_RUN=1`) Lumen odrzuca logowanie na serwer inny niż lokalny
(`ipc.ts: loopbackLogin`, test w `tests/emustart.test.ts`).
