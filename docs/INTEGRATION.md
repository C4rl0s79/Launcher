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
│   core/uiMode.ts           dwa tryby w jednym oknie (pokaż/ukryj widok — bez restartu, bez przeładowania)
│   core/fullscreenBridge.ts most UI EmuStart → silnik; Steam jako system „Steam”
│   library/, steam/, art/…  integracja Steam (bez zmian funkcjonalnych)
│   emustart/engine.ts       proces silnika: start, handshake, token, restart, wywołania
│   emustart/provider.ts     biblioteka i stan EmuStart z silnika (+ kopia offline)
│   emustart/mapping.ts      model EmuStart → wspólny model `Game`
│   emustart/ipc.ts          akcje EmuStart dla trybu pulpitu
├─ widok pulpitu (src/renderer, React) ───── wygląd Lumen
└─ widok TV (WebContentsView, engine/web) ── wygląd EmuStart, preload src/preload/emu.ts
        │ IPC
        ▼
EmuStartEngine.exe / py engine/engine_main.py  (silnik bez okna, 127.0.0.1, token sesji)
   emustart/lumen.py  LumenApi = Api EmuStart + zestawienia biblioteki i zadań
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
- **Prezentacja**: oba tryby wołają te same funkcje rdzenia/silnika. Np. „Graj” na grze EmuStart:
  pulpit → `emustart.launch` → silnik `launch`; tryb TV → `api().launch` → most → silnik `launch`.
  Ta sama sesja uruchamiania jest widoczna w obu trybach.

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
  w szczegółach gry (pulpit) i w opcjach gry (TV),
- **wymaga EmuStart Server 0.46.0** — starszy serwer nie ma API zapisów: gra rusza wtedy na zapisach
  z urządzenia, bez synchronizacji,
- poza paczkami (stany PS2 `.p2s`, Dolphin, PPSSPP, RPCS3) — jak dotąd: folder profilu na serwerze,
  blokada profilu na czas gry, przy konflikcie zostaje nowsza wersja, druga w kopii zapasowej profilu
  (te konflikty pokazuje panel zadań trybu pulpitu i komunikat w trybie TV),
- koniec sesji = koniec procesu emulatora (`proc.wait()`); emulatory uruchamiane przez proces pośredni
  nie są osobno obsługiwane — **niesprawdzone**.

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

Gry o tym samym tytule na tej samej platformie (regiony, rewizje: „Defcon 5 (Europe)”, „(Japan)”, „(Korea)”)
są w trybie pulpitu **jednym plakatem** z odznaką „N wersji” (`main/emustart/versions.ts`). Pozycja pokazuje
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

## 7. Tryby interfejsu

- Jedno okno, dwa widoki: renderer Lumen i `WebContentsView` z UI EmuStart (ładowany w tle przy starcie).
  Przełączenie: F10, View + Start na padzie, przycisk „⛶ Tryb TV”, Menu EmuStart → „Tryb pulpitu (Lumen)”.
- Zachowanie kontekstu: zaznaczona gra przechodzi między trybami (pulpit → TV: system i gra na liście;
  TV → pulpit: ekran szczegółów tej gry).
- Pad: XInput czyta tylko proces główny Lumen (jak dotąd) i kieruje zdarzenia do widocznego trybu
  (w TV — akcje EmuStart z tym samym powtarzaniem co w EmuStart). Menu w grze (A + Y nad emulatorem)
  obsługuje nadal silnik EmuStart.
- „Wyjdź” w menu EmuStart zamyka Lumen (silnik kończy wysyłanie zapisów przed wyjściem).

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
- logowanie, profile i ustawienia systemów są tylko w trybie TV (świadomie — jedna implementacja),
- weryfikacja integralności gier: zgodność rozmiaru z serwerem (EmuStart); emulatory: SHA-256 z manifestu,
- kontrola Steam ograniczona do `steam://` (bez postępu na żywo, pauzy, anulowania — jak w Lumen).

## 9. Incydent podczas testów

Przy pierwszym ręcznym teście trybu TV (bez `LUMEN_DRY_RUN`) Lumen wysłał
`steam://rungameid/798460` i Steam uruchomił grę. Polecenie nie pochodziło ze skryptu testowego —
do okna trafiały naciśnięcia z podłączonego pada (XInput, gniazdo 0). Od tej pory testy automatyczne
używają `LUMEN_DRY_RUN=1` (akcje Steam i uruchamianie emulatorów tylko w logu) i `LUMEN_NO_PAD=1`.
