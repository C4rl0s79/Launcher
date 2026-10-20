# Migracja danych

Zasada: nic nie jest kasowane ani przenoszone automatycznie. Nowa aplikacja czyta dotychczasowe dane
na miejscu, a nowe dane zapisuje obok.

## Dotychczasowy Lumen (SteamLaunch)

Od 0.2.0 dane są w `LumenData\` **obok programu** (instalator, ZIP i portable). Przy pierwszym starcie
z pustym `LumenData\` Lumen **kopiuje** ze starego folderu (`%APPDATA%\Lumen\`) ustawienia, kategorie,
ulubione, wybory grafik (ścieżki własnych grafik są przepisywane na nowy folder), `first-seen.json`,
`secrets.json`, bazę LaunchBox i ostatnią bibliotekę konta Steam. Pamięci podręczne grafik i opisów
budują się od nowa. Stary folder zostaje nietknięty — to jednocześnie kopia zapasowa i droga powrotu.
Istniejący `LumenData\` (np. wersji portable) nigdy nie jest nadpisywany.

Odinstalowanie i aktualizacja instalatorem nie usuwają `LumenData\` (`resources/installer.nsh`).
Folder programu tylko do odczytu (np. `Program Files`) → dane w `%APPDATA%\Lumen\` jak dotąd.

| Plik | Zmiana | Zgodność wstecz |
|---|---|---|
| `settings.json` | nowe pola: `startMode`, `emustartEnabled` (domyślnie włączone), `emustartHome`, `pythonPath` | stary Lumen ignoruje nieznane pola |
| `prefs.json` | nowy rodzaj kategorii `emustart` (`emusys:<system>`); wersja formatu bez zmian (3) | stary Lumen pomija takie kategorie przy wczytaniu (nie psuje pliku; przy jego zapisie znikną i zostaną odtworzone przez nową wersję) |
| `emustart-library.json` | nowy: ostatnia biblioteka z silnika (pokazywana, gdy silnik nie działa) | — |
| `emustart\` | nowy: dane silnika EmuStart, gdy nie wskazano innego folderu | — |

Kopia zapasowa przed pierwszym uruchomieniem (zalecana): skopiuj `%APPDATA%\Lumen\` w bezpieczne
miejsce. `prefs.json` i `settings.json` mają też automatyczne `.bak` (zapis przez plik tymczasowy).

## Dotychczasowy EmuStart

Dane EmuStart leżą obok programu (`config.json`, `data\`, `cache\`, `profiles\`, `logs\`). Dwie drogi:

1. **Nowy folder (domyślnie)** — `LumenData\emustart\` (pobrane gry w `cache\`, emulatory w `emulators\`,
   BIOS-y z serwera w folderze `system` RetroArcha w `emulators\`). Zaloguj urządzenie do serwera w trybie TV
   (Menu → Ustawienia → Zaloguj, link z panelu serwera). Biblioteka, grafiki, profile i zapisy przychodzą
   z serwera; pobrane wcześniej gry pobiorą się ponownie przy pierwszym uruchomieniu.
2. **Istniejący folder EmuStart** — Ustawienia → EmuStart → „Folder danych EmuStart” → **Wybierz…** → folder programu
   EmuStart (np. `D:\emustart`). Silnik używa jego `config.json`, pamięci podręcznej gier, profili
   i klucza urządzenia na miejscu, bez kopiowania. Lumen nie uruchomi silnika, gdy z tego folderu
   działa samodzielny `EmuStart.exe` (dwa procesy na jednych danych to ryzyko uszkodzenia bazy).
   Samodzielnego EmuStart można dalej używać zamiennie (nie jednocześnie) — format danych się nie zmienił.

Powrót: „Przywróć domyślny” przy „Folder danych EmuStart” albo wyłącz „Gry z serwera EmuStart”. Dane w żadnym
z folderów nie są wtedy usuwane.

## Serwer EmuStart

Lumen jest dla serwera zwykłym urządzeniem „pc” z EmuStart 0.46.0 (ten sam protokół logowania i `/v1/…`).
Do synchronizacji zapisów potrzebny jest **EmuStart Server 0.46.0** (API `/v1/savesync`); ze starszym
serwerem biblioteka, pobieranie i granie działają, a gry ruszają na zapisach z urządzenia. Zaktualizuj też
EmuStart na innych komputerach i telefonie — 0.46.0 zmienia układ zapisów (karta pamięci osobna dla gry
w PCSX2/DuckStation, zapisy RetroArcha paczkami).
