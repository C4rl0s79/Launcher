# Architektura i ograniczenia

## Decyzja: osobna aplikacja + lokalne pliki Steam + steam:// + opcjonalne Web API

| Wariant | Wykonalność | Utrzymanie | Biblioteka | Uruchamianie / instalacja | Postęp pobierania | Ryzyko |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Osobna aplikacja** (wybrany) | wysoka | niskie | lokalnie: zainstalowane; Web API: całe konto | `steam://` (udokumentowane) | tylko liczniki z manifestu (z opóźnieniem) | niskie — tylko odczyt plików |
| B. Nakładka/skórka klienta Steam (wstrzykiwanie przez CEF, np. Millennium) | średnia | wysokie — psuje się po aktualizacjach Steam | pełna (dane klienta) | natywne | natywny | wysokie: modyfikacja klienta, nieoficjalne |
| C. Motyw/rozszerzenie Playnite | wysoka | średnie | pełna (integracja Playnite) | przez Playnite | ograniczony | zależność od cudzej aplikacji, to nie byłby własny produkt |

Wariant A daje pełną kontrolę nad UX, nie modyfikuje Steama i działa offline. Brakuje mu tylko
dokładnego postępu pobierania na żywo, co zostało uczciwie odzwierciedlone w interfejsie.

## Stos technologiczny

**Electron 44 + React 19 + TypeScript, budowane electron-vite, pakowane electron-builder.**

- Chromium daje **Gamepad API**, ale na Windows otwiera i inicjalizuje urządzenia samodzielnie (Raw Input/HID, WGI), co
  wyłączało pad podłączany przy działającym Lumen. Dlatego domyślnie proces główny odpytuje **XInput** przez `koffi`
  (`main/input/xinput.ts`, tylko przy fokusie okna), a Gamepad API zostaje jako opcja w ustawieniach.
  sprzętowo akcelerowane renderowanie dużej liczby obrazów i dojrzałą wirtualizację (`@tanstack/react-virtual`).
- Proces główny Node.js ma natywny dostęp do plików, `reg.exe`, `steam://` (`shell.openExternal`), DPAPI (`safeStorage`).
- Rozważane alternatywy: **Tauri** (mniejszy pakiet, ale w środowisku nie było Rusta), **WPF/Avalonia (.NET 10)**
  (natywnie, ale obsługa padów wymaga własnej warstwy XInput/SDL, a efektowny UI z wirtualizacją wymaga więcej pracy).
  Wadą Electrona jest rozmiar (~250 MB po rozpakowaniu) i zużycie RAM.

## Moduły

```
src/
  shared/            typy i kontrakt IPC (types.ts, api.ts)
  main/              proces główny (Node)
    steam/
      vdf.ts           parser tekstowego KeyValues (.vdf/.acf)
      manifests.ts     appmanifest → stan instalacji (StateFlags), postęp, filtr narzędzi
      local.ts         libraryfolders.vdf, skan manifestów, loginusers.vdf, localconfig.vdf (czas gry)
      registry.ts      odczyt HKCU\Software\Valve\Steam (ścieżka, PID, RunningAppID)
      actions.ts       budowanie i otwieranie URI steam://
      webApi.ts        IPlayerService/GetOwnedGames (oficjalne Web API)
      storeMeta.ts     dostawca metadanych: store.steampowered.com/api/appdetails (+ cache)
    library/
      merge.ts         scalanie: manifesty + konto + statystyki lokalne → Game[]
      service.ts       stan biblioteki, watcher folderów, polling stanu gry/Steama
      demo.ts          dane demonstracyjne (wyraźnie oznaczone, id "demo:*")
    art/
      sgdb.ts          klient SteamGridDB v2 (Bearer), limiter, dopasowanie po nazwie
      artwork.ts       rozwiązywanie grafik + cache dyskowy + indeks (także „braków”)
    store/
      jsonFile.ts      bezpieczny zapis JSON (tmp + fsync + rename, .bak, kolejka zapisów)
      prefs.ts         kategorie / ulubione / wybory grafik (czyste funkcje + persystencja)
      settings.ts      ustawienia + sekrety (DPAPI)
    net.ts             fetch z timeoutem, limiter współbieżności z back-offem (429)
    logger.ts          log do pliku z maskowaniem sekretów
    index.ts           okno, protokół lumen-art://, rejestracja IPC
  preload/index.ts   contextBridge → window.lumen (sandbox, contextIsolation)
  renderer/src/      UI (React)
    nav/spatial.ts     czysta geometria nawigacji D-pad
    nav/engine.ts      fokus w DOM: warstwy, pamięć fokusu grup, przewijanie
    nav/input.ts       klawiatura + gamepad → akcje → stos warstw (ekrany, modale)
    screens/           Start, Biblioteka (wirtualizowana siatka), Szczegóły, Ustawienia
    modals/            kategorie gry, wybór grafik, dopasowanie SteamGridDB
    components/        plakat, grafika z placeholderem, klawiatura ekranowa, podpowiedzi
```

Gry mają stabilny klucz `steam:<appid>` (lub `demo:<n>`). Tytuł nigdy nie jest kluczem.

## Źródła danych — co skąd pochodzi

| Dane | Źródło | Typ |
| --- | --- | --- |
| Lokalizacja Steam | rejestr `HKCU\Software\Valve\Steam\SteamPath` (zapas: HKLM, domyślna ścieżka) | lokalne, nieudokumentowane, stabilne od lat |
| Foldery bibliotek | `steamapps/libraryfolders.vdf` | lokalne |
| Zainstalowane gry, stan, rozmiar, liczniki pobierania | `steamapps/appmanifest_<id>.acf` | lokalne |
| Ostatnie uruchomienie, czas gry (ten PC) | `userdata/<accountid>/config/localconfig.vdf` | lokalne |
| Zalogowane konto | rejestr `ActiveProcess\ActiveUser`, `config/loginusers.vdf` | lokalne |
| Uruchomiona gra | rejestr `RunningAppID` (polling co 3 s) | lokalne, nieudokumentowane |
| Grafiki Steam | `appcache/librarycache/<id>/…` i CDN `shared.steamstatic.com/store_item_assets/steam/apps/<id>/…` | lokalne / publiczny CDN |
| Pełna lista posiadanych gier, czas gry z serwera | `IPlayerService/GetOwnedGames` | **oficjalne Web API** (klucz) |
| Opis, gatunki, data premiery, producent, wydawca | `store.steampowered.com/api/appdetails` | publiczny, **nieudokumentowany** endpoint sklepu |
| Grafiki społeczności | SteamGridDB API v2 | zewnętrzne API (klucz) |
| Uruchomienie gry / instalacja / widok w Steam / pobieranie | `steam://rungameid`, `steam://install`, `steam://nav/games/details`, `steam://open/downloads` | **działania przekazywane do klienta** (udokumentowany protokół) |

Źródła:
- Steam browser protocol: <https://developer.valvesoftware.com/wiki/Steam_browser_protocol>
- GetOwnedGames: <https://partner.steamgames.com/doc/webapi/IPlayerService#GetOwnedGames> (dane zwracane tylko, gdy szczegóły gier profilu są widoczne)
- Klucz Web API: <https://steamcommunity.com/dev/apikey>
- SteamGridDB API v2 i oficjalny klient (ścieżki, nagłówek `Authorization: Bearer`): <https://www.steamgriddb.com/api/v2>, <https://github.com/SteamGridDB/node-steamgriddb>
- EAppState (flagi StateFlags): Steamworks SDK `steamclientpublic.h`

## Rzeczy świadomie NIE zrobione

- **Brak modyfikacji plików/konfiguracji Steam.** Tylko odczyt. Kolekcje Steam są **czytane** z
  `userdata/<accountid>/config/cloudstorage/cloud-storage-namespace-1.json` (+ `.modified.json`) i pokazywane
  jako kategorie tylko do odczytu (można je przypinać i ustawiać kolejność w Lumen; zmiana nazwy / zawartości —
  tylko w Steam). Zapis do tego pliku jest nieudokumentowany i ryzykowny, więc go nie robimy. Własne kategorie
  Lumen są lokalne. Plik jest obserwowany — zmiany kolekcji w Steam pojawiają się bez restartu.
- **Kolekcje dynamiczne Steam** (reguły filtrów: tagi, funkcje, obsługa kontrolera…) nie są odtwarzane — Steam
  liczy je z własnych metadanych gier, których Lumen nie ma. Ich nazwy są wymienione w Ustawieniach.

## Skróty spoza Steama (np. emulatory dodane przez Steam ROM Manager)

- Czytane (tylko odczyt) z binarnego `userdata/<accountid>/config/shortcuts.vdf` (`steam/binaryVdf.ts`, `steam/shortcuts.ts`);
  plik jest obserwowany, więc ponowne użycie Steam ROM Managera odświeża bibliotekę bez restartu.
- Id w Lumen: `shortcut:<appid>` (32-bitowy appid bez znaku — ten sam, którego używają kolekcje Steam i folder `grid`).
- Skróty ukryte w Steam (`IsHidden`) są pomijane. Brak pliku programu (`Exe`) → stan „brak programu”, bez akcji „Graj”.
- Uruchamianie przez Steam: `steam://rungameid/<(appid << 32) | 0x02000000>` — Steam stosuje własną konfigurację
  Steam Input, nakładkę i liczy czas gry. Lumen nie uruchamia emulatora bezpośrednio.
- Grafiki: najpierw folder `userdata/<accountid>/config/grid` (`<id>p.*` plakat, `<id>_hero.*`, `<id>_logo.*`,
  `<id>_icon.*`/`<id>.ico`) — tam zapisują je Steam ROM Manager i sam Steam; dalej SteamGridDB po nazwie.
  Ten sam folder ma pierwszeństwo także dla gier Steam (własne okładki ustawione w kliencie Steam).
- Skróty nie mają metadanych ze sklepu; ekran szczegółów pokazuje platformę (tagi Steam, np. PS2) i źródło.
- Wykrywanie końca gry dla skrótów opiera się na tym samym `RunningAppID` — **nie zostało sprawdzone**.
- **Brak logowania do Steam / przechwytywania haseł.**
- **Brak fikcyjnych pasków postępu.** Pasek jest pokazywany tylko wtedy, gdy manifest Steam zawiera
  liczniki `BytesDownloaded/BytesToDownload`; Steam zapisuje je z opóźnieniem, co jest opisane w UI.
  Gdy liczników brak — komunikat i przycisk do okna pobierania Steam.
- **Jedna akcja instalacji.** `steam://install/<id>` otwiera okno instalacji Steam — nie ma osobnego „Pobierz”.

## Zachowanie po uruchomieniu gry

1. `steam://rungameid/<id>` → Steam (uruchamiany automatycznie, jeśli był wyłączony).
2. Lumen minimalizuje się po 1,5 s (4 s jeśli Steam startuje) — opcja w ustawieniach.
3. Gamepad jest ignorowany, gdy okno nie ma fokusu; po powrocie fokusu wciśnięte już przyciski są ignorowane
   do zwolnienia (żeby „A” z gry nie uruchomiło niczego w Lumen).
4. Gdy `RunningAppID` wraca z id gry do 0, Lumen przywraca okno (opcja „eksperymentalne”). Niektóre gry
   (launchery zewnętrzne, anticheat) mogą tego nie raportować poprawnie — **nie jest to gwarantowane**.

## Wydajność

- Siatka biblioteki jest wirtualizowana (w DOM ~50–70 plakatów niezależnie od rozmiaru biblioteki;
  zmierzono 1327 gier: ~5 ms na krok nawigacji).
- Ekran Start pokazuje po 2 pełne rzędy siatki („Ostatnio grane”, „Nowo dodane”); grupy mają wirtualizowaną siatkę.
- Obrazy: `loading="lazy"`, rozdzielczości dopasowane do użycia (plakat 600×900, tło 1920×620),
  pobierane maks. 4 równolegle; zapytania SteamGridDB maks. 3 równolegle z back-offem po HTTP 429.
- Wyniki (także braki) są zapamiętywane w `cache/art/index.json` — kolejne starty nie odpytują sieci.
- Operacje plikowe i sieciowe działają w procesie głównym asynchronicznie; UI ich nie blokuje.

## Przygotowanie na inne źródła gier

`Game.source` i prefiks identyfikatora (`steam:`) wydzielają źródło; scalanie (`library/merge.ts`)
i akcje (`main/index.ts` → `steam/actions.ts`) są jedynymi miejscami zależnymi od Steama. Nowe źródło
wymaga własnego skanera + mapowania akcji. Celowo nie implementowano innych integracji.

## Metadane gier spoza Steama — LaunchBox Games DB

- Źródło: `https://gamesdb.launchbox-app.com/Metadata.zip` (cała baza w jednym pliku, ~110 MB, ~190 tys. gier).
  Pobierane tylko na żądanie (Ustawienia → „Pobierz / Zaktualizuj bazę LaunchBox”). Program nie zależy od EmuStart.
- `launchbox/service.ts` pobiera ZIP strumieniowo, a `launchbox/worker.ts` (wątek roboczy) wypakowuje `Metadata.xml`
  (`yauzl`), parsuje go strumieniowo (`sax`) i zapisuje `launchbox/launchbox.db` przez wbudowane `node:sqlite`.
  Nowa baza powstaje jako `.new` i dopiero po sukcesie zastępuje starą; ZIP jest usuwany. Na tym PC: ~22 s.
- Schemat zgodny z bazą EmuStart (`games`, `names` z nazwami alternatywnymi, `meta`), bez grafik i setów MAME.
- Dopasowanie (`launchbox/match.ts`, `launchbox/lookup.ts`) to port reguł EmuStart: platforma z tagu skrótu
  (PS1/PS2/DC/GCN/Windows…), znormalizowany tytuł (bez tagów, przedimków, interpunkcji), zgodne numery części
  („Part 3” ≠ „Part II”), podobieństwo bigramów ≥ 0,6. Dodatkowo części nazwy po „ - ” (np. „Seria - Tytuł”),
  tylko przy dokładnym kluczu. Ekran gry pokazuje, z jakim wpisem LaunchBox dopasowano grę.
- Opisy w LaunchBox są po angielsku. Bazy nie kasuje „Wyczyść pamięć podręczną” (jej odbudowa to pobranie 110 MB).

## Tryb portable

`Lumen-…-portable.exe` (electron-builder ustawia `PORTABLE_EXECUTABLE_DIR`) trzyma wszystkie dane w `LumenData\`
obok pliku exe — ustawienia, kategorie, cache grafik i bazę LaunchBox. Sekrety są szyfrowane DPAPI dla bieżącego
konta Windows; po przeniesieniu na inny komputer Lumen zgłasza w logu, że trzeba je wpisać ponownie.
