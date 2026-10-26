import { memo, useEffect, useState } from "react";
import type { ArtKind, ArtLayout } from "@shared/types";
import { api, useStore } from "../store";
import { hueOf } from "../lib/format";

interface Props {
  gameId: string;
  name: string;
  kind: ArtKind;
  className?: string;
  /** what to render when there is no image */
  fallback?: "poster" | "hero" | "title" | "none";
  eager?: boolean;
  onState?: (ok: boolean) => void;
  /** "tv": the TV layout's own art (its choices; LaunchBox first for EmuStart games) */
  layout?: ArtLayout;
}

/**
 * Images already shown this session (src → shown whole over a blurred copy): the browser keeps
 * them, so they appear at once — no empty frame and no fade-in when the list changes back.
 */
const shown = new Map<string, boolean>();

/** Image served by the main process (lumen-art://) with a tasteful generated placeholder. */
export const Art = memo(function Art({
  gameId,
  name,
  kind,
  className,
  fallback = "poster",
  eager,
  onState,
  layout,
}: Props) {
  const rev = useStore((s) => s.artRev[gameId] ?? 0);
  const src = api().art.url(gameId, kind, rev, layout);
  const [state, setState] = useState<"loading" | "ok" | "error">(() =>
    shown.has(src) ? "ok" : "loading",
  );
  // a poster image that is not 2:3 (box art from an emulator library: longbox, jewel case, cartridge
  // box) is shown whole over a blurred copy of itself instead of being cropped
  const [fit, setFit] = useState(() => shown.get(src) ?? false);
  const [seen, setSeen] = useState(src);
  if (seen !== src) {
    // a new image (art changed or another game in this slot): known ones at once
    setSeen(src);
    setState(shown.has(src) ? "ok" : "loading");
    setFit(shown.get(src) ?? false);
  }

  // an image known from earlier is "loaded" at once — tell the parent (no onLoad wait)
  useEffect(() => {
    if (shown.has(src)) onState?.(true);
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const hue = hueOf(name);
  if (state === "error") {
    if (fallback === "none") return null;
    if (fallback === "title")
      return <div className={`art-title ${className ?? ""}`}>{name}</div>;
    return (
      <div
        className={`art-placeholder art-placeholder--${fallback} ${className ?? ""}`}
        style={{ ["--h" as string]: hue }}
        aria-label={name}
      >
        {fallback === "poster" && <span>{name}</span>}
      </div>
    );
  }
  return (
    <>
      {fit && (
        <img
          className="art-fit__bg"
          src={src}
          alt=""
          aria-hidden
          draggable={false}
        />
      )}
      <img
        key={src}
        className={`art art--${kind} ${state === "ok" ? "is-loaded" : ""} ${fit ? "art--fit" : ""} ${className ?? ""}`}
        src={src}
        alt=""
        draggable={false}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        style={state === "loading" ? { ["--h" as string]: hue } : undefined}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          const f = kind === "grid" && !!w && !!h && Math.abs(w / h - 2 / 3) > 0.06;
          setFit(f);
          shown.set(src, f);
          if (shown.size > 5000) shown.delete(shown.keys().next().value!);
          setState("ok");
          onState?.(true);
        }}
        onError={() => {
          shown.delete(src);
          setState("error");
          onState?.(false);
        }}
      />
    </>
  );
});
