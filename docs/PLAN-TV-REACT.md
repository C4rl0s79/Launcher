# Plan: jeden interfejs — tryb TV jako układ Lumena (React)

Stan na 20.10.2026 (Lumen 0.5.1, silnik EmuStart 0.48.1).

## Cel

Jedna aplikacja z jednym interfejsem (React, `src/renderer`) i dwoma układami: **pulpit** i **TV**.
Silnik EmuStart (`engine/`, Python) zostaje **tylko jako backend** (API `/api/<metoda>`, synchronizacja,
pobieranie, emulatory, zapisy, blokada profilu) — bez własnego interfejsu. Każda funkcja jest
napisana raz i działa tak samo w obu układach. Układ TV zachowuje wygląd EmuStart (wymóg z briefu).

Dziś tryb TV to osobny interfejs EmuStart (`engine/web`: `app.js`, `options.js`, `look.js`, ~3100
linii) w osobnym widoku okna (`WebContentsView` + most `?lumen`). Stąd rozjazdy: funkcje dodawane
w jednym trybie brakują w drugim (ustawienia, zapisy, przejęcie profilu…), fokus klawiatury, dwa
stany interfejsu do synchronizowania.

## Zasady

- Backend bez zmian w kodzie EmuStart: interfejs woła te same metody API co dziś `web/` (lista
  poniżej). Brakujące zestawienia — w łatkach Lumena (`engine/emustart/lumen.py`), jak dotąd.
- `engine/web` zostaje w subtree (aktualizacje z EmuStart), ale Lumen go nie ładuje i nie pakuje.
- Każdy etap to osobne wydanie Lumena; do ostatniego etapu stary tryb TV działa dalej (przełącznik
  w Ustawieniach: „Tryb TV: nowy / dotychczasowy”), żeby nic nie zniknęło w połowie.
- Sterowanie padem jak dziś w obu układach (`nav/` Lumena); tekst padem — klawiatura ekranowa.

## Funkcje trybu TV do przeniesienia

Legenda — pulpit Lumena dziś: ✔ jest, ◐ częściowo, ✘ brak.

### Ekrany i przeglądanie
| Funkcja (tryb TV dziś) | Pulpit dziś | Do zrobienia |
| --- | --- | --- |
| Ekran systemów (karuzela z logo systemów, liczby gier) | ◐ grupy-platformy w górnym pasku | układ TV: karuzela systemów z logo |
| Lista gier systemu (logo / okładka / zrzut, opis, rok, gracze) | ◐ siatka plakatów | układ TV: lista w stylu EmuStart (te same dane) |
| Filtry listy (`flt`: pobrane, ulubione, tekst) | ◐ filtr + szukaj | wspólny komponent filtrów |
| System „Steam” w TV | ✔ (biblioteka Steam) | Steam jako system w układzie TV z Lumena, bez mostu |
| Ulubione, „ostatnio grane” | ✔ | — |
| Grafiki: logo gry zamiast tytułu („Tytuły gier jako logo”) | ✘ | opcja układu TV |

### Uruchamianie i gra
| Funkcja | Pulpit dziś | Do zrobienia |
| --- | --- | --- |
| Okno uruchamiania: pobieranie, rozpakowanie, „Graj mimo to”, anuluj | ✔ (`Jobs.tsx`) | wspólne, wygląd TV |
| Konflikt zapisów X/Y/B | ✔ | — |
| Profil gra na innym urządzeniu → przejmij | ✔ | — |
| Brak emulatora → zainstaluj z serwera (`install_missing/start/status/cancel`) | ✔ | — |
| **Menu w grze A+Y** (wróć, zapisz/wczytaj stan, reset, quicksave i wyjdź, shader, wyjdź) — `ingame_poll`/`ingame_action` | ✘ | nowy komponent; okno Lumena na wierzch jak dziś |
| Graj od początku / Graj (stan „Kontynuuj”) | ◐ Graj | dodać „od początku” |

### Opcje gry (dziś przytrzymane Enter w TV)
| Funkcja | Pulpit dziś | Do zrobienia |
| --- | --- | --- |
| Wczytaj zapis (stany serwera, inne rdzenie) | ✔ okno „Zapisy” | — |
| Stany PS2 komputer ↔ telefon (`save_manager`/`save_copy`) | ✔ | — |
| Wersja gry (warianty / regiony, `set_variant`) | ◐ wybór wersji (grupy) | ujednolicić z wariantami silnika |
| Emulator dla tej gry (`emulator_options`, `set_game_emulator`, „domyślny dla systemu”) | ✘ (tylko per system) | nowy |
| Ustawienia emulatora: otwórz emulator z ustawieniami profilu (`configure_emulator`), historia i przywracanie (`emu_settings_history/restore`) | ✘ | nowy |
| Bez shadera w tym systemie (`set_shader_off`) | ✘ | nowy |
| Metadane i opis: edycja, „Oryginał”, „Przywróć dane pobrane”, pełne pobranie (`meta_save`, `meta_fetch`, `meta_fetch_full`) | ✘ (tylko odczyt) | nowy |
| Grafiki silnika (okładka/zrzut/logo z serwera: `art_candidates`, `art_choose`, `art_clear`, `request_art`) | ◐ „Grafiki” (SteamGridDB, LaunchBox) | dodać źródło „serwer EmuStart” do okna Grafiki |
| Zachowaj na dysku / usuń z dysku | ✔ | — |

### Konto, profile, logowanie
| Funkcja | Pulpit dziś | Do zrobienia |
| --- | --- | --- |
| Zaloguj: link / adres serwera, konto + hasło, kod do zatwierdzenia, czekanie (`server_enroll*`, `enroll_pending`) | ✘ | nowy kreator (pad + klawiatura ekranowa) |
| Wyloguj z wysłaniem zapisów i pytaniem przy niewysłanych | ✘ | nowy (logika w silniku 0.48) |
| Zatwierdzanie próśb innych urządzeń (`account_requests_poll`, `enroll_decide`, `account_request`) | ✘ | nowy |
| Ekran profili: wybór, nowy, zmiana nazwy, usuń, dołącz konto, wyloguj profil (`profile_*`) | ◐ wybór profilu w Ustawieniach | nowy ekran profili |
| PIN / hasło profilu, odblokowanie (`profile_set_pin`, `profile_pin_check`, `profile_unlock`, `profile_clear_pin`, `profile_set_password`) | ✘ | nowy |
| „Pytaj, kto gra, przy starcie” | ◐ przełącznik | ekran wyboru przy starcie |
| RetroAchievements: logowanie, hardcore, import, stan (`ra_*`) | ✘ | nowy |

### Ustawienia (TV)
| Funkcja | Pulpit dziś | Do zrobienia |
| --- | --- | --- |
| Ukrywanie wersji, klony arcade, profile, emulator i włączenie systemów | ✔ „Biblioteka EmuStart” | — |
| Pamięć podręczna, granie w trakcie pobierania, strumienie naraz | ◐ | dodać „strumieni naraz” |
| Emulatory: wykryj (`autodetect`), pobierz brakujące (`install_missing`) | ◐ | dodać „wykryj” |
| Opcje systemu (`system_options`, `system_set`, logo systemu: `system_logo_candidates/choose`) | ◐ | dodać logo systemu |
| Serwer: stan, konto, przez który adres, zapisy czekające na wysłanie (`post_status`, `emu_sync_status`) | ◐ stan w Ustawieniach | uzupełnić |
| Odśwież bibliotekę z serwera | ✔ | — |
| Kolejność padów (`pads_state`, `pads_set`) | ✘ | nowy ekran |
| Pełny ekran, obsługa padów w menu | ✔ (Lumen) | — |
| Klucze źródeł grafik → serwer (`art_keys_push`) | ✘ | nowy (rzadkie) |
| Lokalne foldery gier, skan (`rescan`, `scan_status`, `browse`, `pick_folder`) — dla gier spoza serwera | ✘ | **decyzja** (u Ciebie lista folderów jest pusta — biblioteka tylko z serwera) |
| Edytor wyglądu EmuStart (`look.js`: logo, czcionki, kolory) | ✘ | **decyzja** |
| Aktualizacja programu | ✔ (Lumen) | — |

### Elementy interfejsu
| Funkcja | Pulpit dziś | Do zrobienia |
| --- | --- | --- |
| Klawiatura ekranowa (`osk`) do pisania padem | ✘ (`TextField` z klawiaturą) | nowy komponent, używany w obu układach |
| Przeglądarka folderów padem (`fbrowse`) | ✔ `PathPicker` | — |
| Menu (Tab / Start) | ◐ | menu układu TV |
| Podpowiedzi przycisków | ✔ `Hints` | — |

## Etapy (każdy = wydanie)

1. ✔ **(Lumen 0.6.0) Fundament układu TV** — przełączanie pulpit ↔ TV w jednym rendererze (bez `WebContentsView`),
   ekran systemów, lista gier w stylu EmuStart, Steam jako system, okno uruchamiania, menu,
   klawiatura ekranowa. Stary tryb TV dostępny przełącznikiem.
2. **Opcje gry** — emulator dla gry, ustawienia emulatora z historią, bez shadera, metadane i
   opis, grafiki z serwera EmuStart, „Graj od początku”, warianty.
3. **Konto i profile** — logowanie / wylogowanie, zatwierdzanie urządzeń, ekran profili, PIN i
   hasła, wybór gracza przy starcie, RetroAchievements.
4. **Menu w grze (A+Y) i pady** — menu w grze, kolejność padów.
5. **Reszta ustawień** — strumienie, wykrywanie emulatorów, logo systemów, klucze grafik, (po
   decyzji) foldery lokalne i edytor wyglądu.
6. **Usunięcie starego trybu TV** — bez `WebContentsView`, mostu `fullscreenBridge`, preloadu
   `emu`, kodu `?lumen` w `engine/web`; PyInstaller bez `web/`; dokumentacja.

Każdy etap: testy jednostkowe komponentów i mapowań API, przejście klawiaturą/padem w obu
układach (zrzuty ekranu), lista zgodności z tabelą powyżej.

## Decyzje (20.10.2026)

Stały wygląd EmuStart bez edytora (na razie); bez lokalnych folderów z grami; samodzielny EmuStart
zostaje na tym komputerze jako zapas.

Pierwotne pytania:

1. **Edytor wyglądu EmuStart** (logo, czcionki, kolory układu TV) — przenieść, czy układ TV ma
   stały wygląd EmuStart (+ jasny/ciemny z Lumena)? Propozycja: stały wygląd, edytor później.
2. **Lokalne foldery z grami** (gry spoza serwera, skan) — przenieść, czy Lumen = biblioteka z
   serwera + Steam? Propozycja: na razie bez (u Ciebie lista jest pusta), wrócić, gdy będzie potrzeba.
3. **Samodzielny EmuStart na tym komputerze** — po etapie 6 Lumen robi wszystko, co EmuStart;
   EmuStart na PC zostaje dla innych komputerów / jako zapas, czy go odinstalować tutaj?
