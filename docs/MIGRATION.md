# Migracja danych

Zasada: nic nie jest kasowane ani przenoszone automatycznie. Nowa aplikacja czyta dotychczasowe dane
na miejscu, a nowe dane zapisuje obok.

## Dotychczasowy Lumen (SteamLaunch)

Nazwa produktu i folder danych są te same (`%APPDATA%\Lumen\`, portable: `LumenData\`), więc
ustawienia, kategorie, ulubione, wybory grafik, `first-seen.json`, cache i baza LaunchBox są używane
bez zmian.

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

1. **Nowy folder (domyślnie)** — `%APPDATA%\Lumen\emustart\`. Zaloguj urządzenie do serwera w trybie TV
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

Bez zmian i bez migracji: Lumen jest dla serwera zwykłym urządzeniem „pc” (ten sam protokół logowania,
`/v1/…`, ta sama obsługa zapisów).
