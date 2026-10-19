# Testy

## Automatyczne (`npm test`)

71 testów (vitest), bez sieci i bez prawdziwego Steama (fixture'y w `tests/fixtures`):

- `tests/steam.test.ts` — parser VDF (zagnieżdżenia, escape, BOM, błędy), mapowanie StateFlags → stan,
  postęp tylko z prawdziwych liczników, filtr narzędzi, `libraryfolders.vdf` (nowy i stary format),
  skan wielu bibliotek z uszkodzonym manifestem, brakujący folder, `localconfig.vdf`, `loginusers.vdf`,
  konwersje SteamID, parser `reg query`, Web API (lista / profil prywatny), metadane sklepu, scalanie bibliotek.
- `tests/prefs.test.ts` — tworzenie / zmiana nazwy / przypinanie / kolejność / usuwanie kategorii,
  duplikaty, kategorie wbudowane, wiele kategorii na grę, ulubione, migracja uszkodzonych danych,
  trwałość po „restarcie”, odzyskanie z `.bak`, współbieżne zapisy, maskowanie sekretów w logach.
- `tests/art.test.ts` — parametry SteamGridDB, filtr NSFW, dopasowanie po nazwie, cache (brak ponownego
  pobierania po restarcie), deduplikacja żądań, fallback wyszukiwania po nazwie, ręczne dopasowanie,
  zapamiętane braki, działanie bez klucza (grafiki lokalne Steam), CDN Steam, wybory użytkownika,
  awaria sieci / zły klucz, czyszczenie cache.
- `tests/nav.test.ts` — geometria nawigacji (wiersze, końce wierszy, pasek narzędzi), mapowanie klawiatury
  (w tym pola tekstowe), mapowanie pada i martwa strefa gałki, URI `steam://`.

## Sprawdzone ręcznie na tym komputerze (19.10.2026, Windows 11, Steam uruchomiony)

Aplikacja sterowana przez Chrome DevTools Protocol (`scripts/cdp.mjs`: zrzuty ekranu, symulowane klawisze):

- [x] `npm run dev` / `electron .`, spakowany `release/win-unpacked/Lumen.exe` i `release/Lumen-0.1.0-portable.exe` uruchamiają się (instalatora NSIS nie uruchamiałem — instalowałby aplikację w systemie).
- [x] Wykrycie Steam (rejestr), 2 folderów bibliotek, 66 zainstalowanych gier (narzędzia odfiltrowane).
- [x] Czas gry i ostatnie uruchomienie z `localconfig.vdf`.
- [x] Z kluczem Web API: pełna biblioteka konta (1327 gier), oznaczenie źródła w UI.
- [x] Brak klucza Web API: wyraźny komunikat „tylko gry wykryte na dysku”.
- [x] Brak Steam (`LUMEN_STEAM_PATH=none`): brak awarii, ekran „Nie znaleziono Steam”.
- [x] Brak sieci (`LUMEN_OFFLINE=1`): UI reaguje, grafiki z lokalnego cache Steama, komunikat w szczegółach.
- [x] Szczegóły pokazują właściwą grę (logo, opis PL, gatunki, premiera, producent, wydawca, rozmiar, biblioteka).
- [x] Akcja główna „Graj” dla zainstalowanej gry; fokus startowy na niej.
- [x] Esc zamyka szczegóły i przywraca zaznaczenie na tym samym plakacie.
- [x] Wyszukiwanie po nazwie, filtr, liczniki.
- [x] Ulubione (F), przypisanie do kategorii, tworzenie / zmiana nazwy / przypięcie / przesunięcie kategorii,
      **trwałość po restarcie aplikacji**.
- [x] Przejście klawiaturą przez cały ekran Ustawień (bez pułapek fokusu), modale wracają fokusem do przycisku.
- [x] SteamGridDB: plakaty w siatce, lista 38 propozycji, zapis wyboru, wyszukiwanie dopasowania.
- [x] Brak klucza SteamGridDB: biblioteka działa na grafikach Steam.
- [x] Klucze zapisane zaszyfrowane (DPAPI); brak jawnych kluczy w profilu, logach, `src/`, `out/`.
- [x] Tryb demo — wyraźnie oznaczony.
- [x] Wirtualizacja przy 1327 grach (~5 ms / krok nawigacji, ~50–70 plakatów w DOM).
- [~] Kontroler: Chromium wykrył „Xbox 360 Controller (XInput STANDARD GAMEPAD)” i interfejs przełączył się
      na glify pada (wejście z pada zostało obsłużone). Pełnej ścieżki padem nie przechodziłem — nie mam
      fizycznego dostępu do urządzenia.

## Do sprawdzenia ręcznie (wymaga Ciebie)

Celowo **nie** wykonane automatycznie, bo uruchamiają grę lub okna Steam na Twoim komputerze:

- [ ] **Graj**: w szczegółach zainstalowanej gry naciśnij „Graj” → gra startuje przez Steam,
      Lumen minimalizuje się po ~1,5 s.
- [ ] **Powrót po grze**: zamknij grę → po ≤3 s Lumen wraca na pierwszy plan (opcja eksperymentalna;
      zanotuj gry, dla których nie działa — np. z zewnętrznym launcherem).
- [ ] Podczas gry pad **nie** steruje Lumen (okno nie ma fokusu).
- [ ] **Zainstaluj**: na niezainstalowanej grze (np. Biblioteka → filtr „Niezainstalowane”) → otwiera się okno
      instalacji Steam. Możesz je anulować — nic nie zostanie pobrane bez potwierdzenia w Steam.
- [ ] Gra w trakcie pobierania: status „Instalowanie / Aktualizowanie w Steam”, pasek z manifestu
      (z opóźnieniem) lub komunikat, przycisk „Pokaż pobieranie w Steam”.
- [ ] Steam wyłączony: „Graj” uruchamia Steam, a potem grę.
- [ ] „Otwórz w Steam” i „Strona sklepu” otwierają właściwy widok klienta.
- [ ] **Kontroler**: D-pad/gałka po rzędach i siatce, A/B, X (ulubiona), Y (szukaj → klawiatura ekranowa),
      LB/RB (zakładki), Start (ustawienia), View (filtr), LT/RT (szybkie przewijanie, przytrzymanie = powtarzanie).
- [ ] Steam Input: czy pad nie porusza jednocześnie kursorem (patrz README).
- [ ] Telewizor 4K / skalowanie 150–200%: czytelność, ostrość plakatów, pełny ekran (F11 / ustawienie startowe).
- [ ] „Wybierz plik…” w oknie Grafik (systemowe okno wyboru pliku).
- [ ] Instalator `release/Lumen-0.1.0-setup.exe` (instalacja, skróty, deinstalacja).
