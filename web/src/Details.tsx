import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Accommodation, Rating, Resort } from "./lib";

const search = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const plainName = (name: string) => name.replace(/\*+/g, "").replace(/\s+/g, " ").trim();

/** Google Maps rating as stars; links to the place's reviews on Google Maps. */
export function Stars({ rating }: { rating: Rating }) {
  if (rating.rating == null) return null;
  const value = rating.rating.toLocaleString("hu-HU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const label = `Google-értékelés: ${value} az 5-ből${rating.count ? `, ${rating.count} vélemény alapján` : ""}`;
  const body = (
    <>
      <span className="stars" aria-hidden="true">
        <span style={{ width: `${(rating.rating / 5) * 100}%` }}>★★★★★</span>
      </span>
      <strong>{value}</strong>
      {rating.count ? <span className="muted">({rating.count.toLocaleString("hu-HU")} Google-vélemény)</span> : <span className="muted">Google</span>}
    </>
  );
  return rating.url ? (
    <a className="rating" href={rating.url} target="_blank" rel="noreferrer" aria-label={`${label} – vélemények megnyitása a Google Térképen`} title="Vélemények a Google Térképen">
      {body}
    </a>
  ) : (
    <span className="rating" role="img" aria-label={label}>
      {body}
    </span>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="close" aria-label="Bezárás" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="ext" href={href} target="_blank" rel="noreferrer">
      {children} <span aria-hidden="true">↗</span>
    </a>
  );
}

const PISTES = [
  ["green", "zöld"],
  ["blue", "kék"],
  ["red", "piros"],
  ["black", "fekete"],
] as const;

const LIFTS = [
  ["cabine", "kabinos"],
  ["seating", "ülőlift"],
  ["pulling", "húzólift"],
  ["railway", "sikló / vasút"],
] as const;

/** Piste mix, lifts and altitude: the at-a-glance facts about a ski area. */
export function ResortFacts({ resort }: { resort: Resort }) {
  const pistes = PISTES.map(([key, label]) => ({ key, label, km: resort.kmByColor[key] ?? 0 })).filter((p) => p.km > 0);
  const sum = pistes.reduce((a, p) => a + p.km, 0);
  const lifts = LIFTS.map(([key, label]) => ({ label, n: resort.lifts?.[key] ?? 0 })).filter((l) => l.n > 0);
  return (
    <div className="facts-grid">
      <div className="stat">
        <span className="label">Pályák</span>
        <strong>{resort.km} km</strong>
      </div>
      <div className="stat">
        <span className="label">Magasság</span>
        <strong>{resort.height ?? (resort.peak ? `${resort.peak} m` : "–")}</strong>
      </div>
      <div className="stat">
        <span className="label">Felvonók</span>
        <strong>{lifts.reduce((a, l) => a + l.n, 0) || "–"}</strong>
      </div>
      {sum > 0 && (
        <div className="pistes">
          <div className="pistebar" role="img" aria-label={pistes.map((p) => `${p.label}: ${p.km} km`).join(", ")}>
            {pistes.map((p) => (
              <span key={p.key} className={`piste ${p.key}`} style={{ flexGrow: p.km }} title={`${p.label}: ${p.km} km`} />
            ))}
          </div>
          <ul className="legend">
            {pistes.map((p) => (
              <li key={p.key}>
                <span className={`dot piste ${p.key}`} aria-hidden="true" />
                {p.label} {p.km} km
              </li>
            ))}
          </ul>
        </div>
      )}
      {lifts.length > 0 && <p className="lifts muted">{lifts.map((l) => `${l.n} ${l.label}`).join(" · ")}</p>}
    </div>
  );
}

export function ResortLinks({ resort }: { resort: Resort }) {
  return (
    <div className="links">
      <ExtLink href={resort.website ?? search(`${resort.name} ski resort official site`)}>
        {resort.website ? "A síterep hivatalos oldala" : "Síterep keresése"}
      </ExtLink>
      <ExtLink href={resort.url}>Leírás a Travelexen</ExtLink>
      {resort.programs && <ExtLink href={resort.programs}>Programajánló (PDF)</ExtLink>}
      {resort.video && <ExtLink href={resort.video.replace("/embed/", "/watch?v=").replace(/\?showinfo=\d+$/, "")}>Videó</ExtLink>}
    </div>
  );
}

export function ResortDialog({ resort, onClose }: { resort: Resort; onClose: () => void }) {
  return (
    <Dialog title={resort.name} onClose={onClose}>
      <ResortFacts resort={resort} />
      {resort.map && (
        <a className="pistemap" href={resort.map} target="_blank" rel="noreferrer" title="Megnyitás teljes méretben">
          <img src={resort.map} alt={`${resort.name} sítérképe`} loading="lazy" />
          <span>Sítérkép megnyitása teljes méretben ↗</span>
        </a>
      )}
      <ResortLinks resort={resort} />
    </Dialog>
  );
}

export function AccommodationDialog({ resort, acc, rating, onClose }: { resort: Resort; acc: Accommodation; rating?: Rating; onClose: () => void }) {
  const photos = acc.photos ?? [];
  const [i, setI] = useState(0);
  const step = (d: number) => setI((p) => (p + d + photos.length) % photos.length);
  const query = `${plainName(acc.name)} ${resort.name}`;
  const [mapIdx, setMapIdx] = useState(0);
  const maps = [
    acc.pisteMap
      ? { label: "Sítérkép", src: acc.pisteMap, note: "A szállás helye a sítérképen" }
      : resort.map
        ? { label: "Sítérkép", src: resort.map, note: "Általános sítérkép (a szállás nincs rajta jelölve)" }
        : null,
    acc.townMap ? { label: "Várostérkép", src: acc.townMap, note: "A szállás helye a településen" } : null,
  ].filter((m): m is { label: string; src: string; note: string } => m !== null);
  return (
    <Dialog title={acc.name} onClose={onClose}>
      <p className="muted">
        {resort.name}
        {acc.subtitle ? ` · ${acc.subtitle}` : ""}
        {acc.distance ? ` · pálya: ${acc.distance}` : ""}
      </p>
      {rating && <Stars rating={rating} />}
      {photos.length > 0 && (
        <div
          className="gallery"
          tabIndex={0}
          aria-label="Képgaléria"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") step(-1);
            if (e.key === "ArrowRight") step(1);
          }}
        >
          <figure>
            <img src={photos[i].src} alt={photos[i].caption ?? acc.name} />
            {photos.length > 1 && (
              <>
                <button className="nav prev" aria-label="Előző kép" onClick={() => step(-1)}>
                  ‹
                </button>
                <button className="nav next" aria-label="Következő kép" onClick={() => step(1)}>
                  ›
                </button>
              </>
            )}
            <figcaption>
              <span>{photos[i].caption}</span>
              <span className="muted">
                {i + 1} / {photos.length}
              </span>
            </figcaption>
          </figure>
          <div className="strip">
            {photos.map((p, n) => (
              <button key={p.src} className={n === i ? "on" : ""} aria-label={`${n + 1}. kép`} aria-current={n === i} onClick={() => setI(n)}>
                <img src={p.thumb} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}
      {maps.length > 0 && (
        <section className="maps">
          <div className="segmented" style={{ gridTemplateColumns: `repeat(${maps.length}, 1fr)` }}>
            {maps.map((m, n) => (
              <button key={m.src} className={n === mapIdx ? "on" : ""} aria-pressed={n === mapIdx} onClick={() => setMapIdx(n)}>
                {m.label}
              </button>
            ))}
          </div>
          <a className="pistemap" href={maps[mapIdx].src} target="_blank" rel="noreferrer" title="Megnyitás teljes méretben">
            <img key={maps[mapIdx].src} src={maps[mapIdx].src} alt={`${acc.name}: ${maps[mapIdx].label}`} loading="lazy" />
            <span>{maps[mapIdx].note} · megnyitás teljes méretben ↗</span>
          </a>
        </section>
      )}
      <div className="links">
        <ExtLink href={acc.url ?? `${resort.url}/szallas`}>Részletes leírás a Travelexen</ExtLink>
        <ExtLink href={acc.gmaps ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`}>Google Térkép</ExtLink>
        <ExtLink href={search(query)}>Keresés a neten (képek, értékelések)</ExtLink>
      </div>
    </Dialog>
  );
}

export function ResortsTab({ resorts, onOpen, onOffers }: { resorts: Resort[]; onOpen: (r: Resort) => void; onOffers: (r: Resort) => void }) {
  return (
    <section className="resort-grid">
      {resorts.map((r) => (
        <article key={r.id} className="panel resort">
          <button className="resort-img" style={r.image ? { backgroundImage: `url(${r.image})` } : undefined} onClick={() => onOpen(r)} aria-label={`${r.name}: sítérkép és részletek`}>
            <span>Sítérkép</span>
          </button>
          <h3>{r.name}</h3>
          <ResortFacts resort={r} />
          <div className="links">
            <button className="linkish" onClick={() => onOpen(r)}>
              Sítérkép és részletek
            </button>
            <button className="linkish" onClick={() => onOffers(r)}>
              Ajánlatok itt ({r.accommodations.length} szállás)
            </button>
            {r.website && <ExtLink href={r.website}>Hivatalos oldal</ExtLink>}
          </div>
        </article>
      ))}
    </section>
  );
}
