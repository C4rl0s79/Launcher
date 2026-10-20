import { useEffect, useState } from "react";
import type { EmuRemoteState, EmuSaves as Saves, Game } from "@shared/types";
import { api, attempt, useStore } from "../store";
import { formatBytes, formatLastPlayed } from "../lib/format";
import { Modal } from "./Modal";

// A game's saves in the desktop interface — the same data as EmuStart's game options in TV mode:
// sync status of in-game saves, save states on this PC ("Wczytaj zapis") and PS2 states of this
// PC and the phone (save manager, through the server).

const PLATFORM: Record<string, string> = {
  windows: "Komputer",
  android: "Telefon",
  shared: "Wszystkie urządzenia",
};

function slotLabel(slot: string): string {
  const s = String(slot).toLowerCase();
  if (s === "auto") return "autozapis";
  if (s === "resume") return "wznowienie";
  if (s === "autosave") return "autozapis przy wyjściu";
  if (s.startsWith("autosave.")) return `autozapis ${s.split(".")[1]}`;
  return `slot ${Number(s)}`;
}

const when = (unix: number): string =>
  unix
    ? new Date(unix * 1000).toLocaleString("pl-PL", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";

function syncText(s: Saves["sync"]): string {
  if (s.state === "synced")
    return `Zsynchronizowane z serwerem${s.last ? ` · ${formatLastPlayed(s.last) ?? ""}` : ""}`;
  if (s.state === "pending")
    return "Czekają na wysłanie — wyślą się, gdy serwer będzie dostępny";
  if (s.state === "never")
    return "Jeszcze nie synchronizowane — zapisy wyślą się po pierwszej grze";
  return s.state;
}

export function EmuSaves({
  game,
  onClose,
}: {
  game: Game;
  onClose: () => void;
}) {
  const [data, setData] = useState<Saves | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);

  const load = (): void => {
    setError(null);
    void api()
      .emustart.saves(game.id)
      .then(setData)
      .catch((e: Error) =>
        setError(e.message || "Nie udało się odczytać zapisów."),
      );
  };
  useEffect(load, [game.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const play = async (state: string): Promise<void> => {
    setBusy(true);
    const r = await attempt(api().emustart.launch(game.id, state));
    setBusy(false);
    if (!r) return;
    if (!r.ok) toast(r.error ?? "Nie udało się uruchomić gry.", "error");
    else onClose();
  };

  const copy = async (
    st: EmuRemoteState,
    t: EmuRemoteState["targets"][number],
  ): Promise<void> => {
    setBusy(true);
    const r = await attempt(
      api().emustart.copyState(game.id, st.rel, t.platform, t.emu),
    );
    setBusy(false);
    if (!r) return;
    toast(
      r.ok
        ? (r.message ?? "Skopiowano.")
        : (r.error ?? "Nie udało się skopiować."),
      r.ok ? "info" : "error",
    );
    if (r.ok) load();
  };

  return (
    <Modal title={`Zapisy — ${game.name}`} onClose={onClose} wide>
      {!data && !error && (
        <p className="details__loading">
          Wczytuję zapisy (najnowsze pobierają się z serwera)…
        </p>
      )}
      {error && (
        <div className="modal__row">
          <p className="details__muted">{error}</p>
          <button className="btn" data-nav data-autofocus onClick={load}>
            Spróbuj ponownie
          </button>
        </div>
      )}
      {data && (
        <>
          <h3 className="saves__h">Zapisy w grze</h3>
          <p className="details__muted">
            {syncText(data.sync)}. Zapisy w grze i karty pamięci synchronizują
            się same przed grą i po niej — wspólne dla komputera i telefonu.
          </p>

          <h3 className="saves__h">Stany na tym komputerze</h3>
          {data.states.length === 0 && (
            <p className="details__muted">
              Brak stanów tej gry (zapisz stan w emulatorze, a pojawi się
              tutaj).
            </p>
          )}
          <div className="saves__list" data-nav-group="saves-local">
            {data.states.map((st, i) => (
              <button
                key={st.path}
                className="saves__row"
                data-nav
                data-autofocus={i === 0 || undefined}
                disabled={busy}
                onClick={() => void play(st.path)}
              >
                {st.thumb ? (
                  <img className="saves__thumb" src={st.thumb} alt="" />
                ) : (
                  <span className="saves__thumb saves__thumb--none" />
                )}
                <span className="saves__text">
                  <strong>{st.label}</strong>
                  <small>{when(st.time)}</small>
                </span>
                <span className="saves__act">Graj od tego stanu</span>
              </button>
            ))}
          </div>

          {data.remote.ok && data.remote.states.length > 0 && (
            <>
              <h3 className="saves__h">Stany PS2 — komputer i telefon</h3>
              <div className="saves__list" data-nav-group="saves-remote">
                {data.remote.states.map((st) => (
                  <div key={st.rel} className="saves__row saves__row--static">
                    <span className="saves__text">
                      <strong>
                        {PLATFORM[st.platform] ?? st.platform} ·{" "}
                        {st.label.replace(/ na (komputerze|telefonie)$/, "")} ·{" "}
                        {slotLabel(st.slot)}
                      </strong>
                      <small>
                        {when(st.mtime)} · {formatBytes(st.size)}
                      </small>
                    </span>
                    <span className="saves__targets">
                      {st.targets.length === 0 && (
                        <small>brak tego emulatora na drugiej platformie</small>
                      )}
                      {st.targets.map((t) => (
                        <button
                          key={t.platform + t.emu}
                          className="btn btn--sm"
                          data-nav
                          disabled={busy}
                          title={t.note}
                          onClick={() => void copy(st, t)}
                        >
                          {t.ok === true ? "✓" : t.ok === false ? "✗" : "?"}{" "}
                          Kopiuj na: {t.label}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {!data.remote.ok && (
            <p className="details__muted">
              Stany z telefonu: {data.remote.reason}
            </p>
          )}
          <div className="modal__row">
            <button className="btn" data-nav data-autofocus={data.states.length === 0 || undefined} onClick={load}>
              Odśwież
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
