import { useEffect, useMemo, useState } from "react";
import { AccommodationDialog, ResortDialog, ResortsTab, Stars } from "./Details";
import {
  allocate,
  bookingUrl,
  fmtDateTime,
  fmtDay,
  fmtEur,
  fmtWeek,
  MODE_LABEL,
  type Accommodation,
  type Allocation,
  type ChangeEvent,
  type Data,
  type Mode,
  type Rating,
  type Resort,
  type Snapshot,
  type Week,
} from "./lib";

type Tab = "offers" | "resorts" | "sellout" | "changes";
type Detail = { resort: Resort; acc?: Accommodation } | null;
type Sort = "price" | "priceDesc" | "date" | "km" | "distance" | "rating";

interface Filters {
  people: number;
  mode: Mode;
  minPrice: string;
  maxPrice: string;
  weeks: string[];
  resorts: number[];
  minKm: string;
  maxDist: string;
  maxCap: string;
  minRating: string;
  noEmpty: boolean;
  course: boolean;
  sort: Sort;
}

const DEFAULTS: Filters = {
  people: 4,
  mode: "car",
  minPrice: "",
  maxPrice: "",
  weeks: [],
  resorts: [],
  minKm: "",
  maxDist: "",
  maxCap: "",
  minRating: "",
  noEmpty: false,
  course: false,
  sort: "price",
};

const STORAGE_KEY = "travelex-filter-v1";
const PAGE = 30;

function loadFilters(): Filters {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

interface Offer {
  resort: Resort;
  acc: Accommodation;
  week: Week;
  alloc: Allocation;
  fullTypes: number;
  rating?: Rating;
}

async function getJson<T>(name: string, fallback?: T): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`, { cache: "no-cache" });
  if (!res.ok) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name}: HTTP ${res.status}`);
  }
  return res.json();
}

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("offers");
  const [f, setF] = useState<Filters>(loadFilters);
  const [shown, setShown] = useState(PAGE);
  const [detail, setDetail] = useState<Detail>(null);

  useEffect(() => {
    getJson<Data>("data.json").then(setData, (e) => setError(String(e.message ?? e)));
    getJson<ChangeEvent[]>("events.json", []).then(setEvents, () => {});
    getJson<Snapshot[]>("sellout.json", []).then(setSnapshots, () => {});
    getJson<Record<string, Rating>>("ratings.json", {}).then(setRatings, () => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
    } catch {
      /* storage unavailable: filters just won't persist */
    }
    setShown(PAGE);
  }, [f]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setF((p) => ({ ...p, [key]: value }));

  const allWeeks = useMemo(() => {
    const m = new Map<string, string>();
    data?.resorts.forEach((r) => r.accommodations.forEach((a) => a.weeks.forEach((w) => m.set(w.start, w.end))));
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const hasRatings = useMemo(() => Object.values(ratings).some((r) => r.rating != null), [ratings]);

  const offers = useMemo(() => {
    if (!data) return [];
    const out: Offer[] = [];
    const min = Number(f.minPrice) || 0;
    const max = Number(f.maxPrice) || Infinity;
    const minKm = Number(f.minKm) || 0;
    const maxDist = Number(f.maxDist) || Infinity;
    const minRating = hasRatings ? Number(f.minRating) || 0 : 0;
    const opts = { maxCapacity: Number(f.maxCap) || undefined, noEmptyBeds: f.noEmpty };
    // Selections that no longer exist in the data (e.g. a past week) must not hide everything.
    const weeks = f.weeks.filter((w) => allWeeks.some(([s]) => s === w));
    const resorts = f.resorts.filter((id) => data.resorts.some((r) => r.id === id));
    for (const resort of data.resorts) {
      if (resorts.length && !resorts.includes(resort.id)) continue;
      if ((resort.km ?? 0) < minKm) continue;
      for (const acc of resort.accommodations) {
        if (maxDist !== Infinity && (acc.distanceM == null || acc.distanceM > maxDist)) continue;
        const rating = ratings[acc.id]?.rating != null ? ratings[acc.id] : undefined;
        if (minRating && (rating?.rating ?? 0) < minRating) continue;
        for (const week of acc.weeks) {
          if (weeks.length && !weeks.includes(week.start)) continue;
          if (f.course && !resort.courseWeeks.includes(week.start)) continue;
          const alloc = allocate(week, acc.types, f.people, f.mode, opts);
          if (!alloc || alloc.perPerson < min || alloc.perPerson > max) continue;
          const fullTypes = Object.values(week.cells).filter((c) => c.full).length;
          out.push({ resort, acc, week, alloc, fullTypes, rating });
        }
      }
    }
    const by: Record<Sort, (a: Offer, b: Offer) => number> = {
      price: (a, b) => a.alloc.total - b.alloc.total,
      priceDesc: (a, b) => b.alloc.total - a.alloc.total,
      date: (a, b) => a.week.start.localeCompare(b.week.start) || a.alloc.total - b.alloc.total,
      km: (a, b) => (b.resort.km ?? 0) - (a.resort.km ?? 0) || a.alloc.total - b.alloc.total,
      distance: (a, b) => (a.acc.distanceM ?? 1e9) - (b.acc.distanceM ?? 1e9) || a.alloc.total - b.alloc.total,
      rating: (a, b) => (b.rating?.rating ?? 0) - (a.rating?.rating ?? 0) || a.alloc.total - b.alloc.total,
    };
    return out.sort(by[f.sort]);
  }, [data, f, allWeeks, ratings, hasRatings]);

  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  return (
    <>
      <header className="hero">
        <div className="snow" aria-hidden="true" />
        <div className="aurora" aria-hidden="true" />
        <div className="hero-inner">
          <p className="brand">TRAVELEX · SZŰRŐ</p>
          <h1>
            Találd meg a telet,
            <br />
            ami belefér a keretbe
          </h1>
          <p className="lede">
            A travelex.si francia síútjai létszám, utazási mód, ár és időpont szerint – a megtelt helyek nélkül.
          </p>
        </div>
        <Mountains />
      </header>

      <main>
        <nav className="tabs" role="tablist" aria-label="Nézetek">
          {(
            [
              ["offers", "Ajánlatok"],
              ["resorts", "Síterepek"],
              ["sellout", "Telítettség"],
              ["changes", "Változások"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
              {id === "changes" && events.length > 0 && <span className="count">{events.length}</span>}
            </button>
          ))}
          {data && <span className="updated">Frissítve: {fmtDateTime(data.scrapedAt)}</span>}
        </nav>

        {error && <p className="panel notice">Nem sikerült betölteni az adatokat ({error}).</p>}
        {!data && !error && <p className="panel notice">Adatok betöltése…</p>}

        {data && tab === "offers" && (
          <div className="layout">
            <aside className="panel filters" aria-label="Szűrők">
              <div className="field">
                <label htmlFor="people">Hányan utaztok?</label>
                <div className="stepper">
                  <button aria-label="Kevesebb" onClick={() => set("people", Math.max(1, f.people - 1))}>
                    −
                  </button>
                  <input
                    id="people"
                    type="number"
                    min={1}
                    max={60}
                    value={f.people}
                    onChange={(e) => set("people", Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
                  />
                  <button aria-label="Több" onClick={() => set("people", Math.min(60, f.people + 1))}>
                    +
                  </button>
                </div>
              </div>

              <div className="field">
                <span className="label">Utazás módja</span>
                <div className="segmented">
                  {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                    <button key={m} className={f.mode === m ? "on" : ""} aria-pressed={f.mode === m} onClick={() => set("mode", m)}>
                      {m === "car" ? "Egyéni" : MODE_LABEL[m]}
                    </button>
                  ))}
                </div>
                {f.mode === "flight" && (
                  <p className="hint">A repülős ár a reptéri transzfert és a csomagszállítást tartalmazza, a repülőjegyet nem.</p>
                )}
              </div>

              <div className="field">
                <span className="label">Ár / fő (€)</span>
                <div className="range">
                  <input type="number" min={0} step={10} placeholder="min." aria-label="Minimum ár" value={f.minPrice} onChange={(e) => set("minPrice", e.target.value)} />
                  <span>–</span>
                  <input type="number" min={0} step={10} placeholder="max." aria-label="Maximum ár" value={f.maxPrice} onChange={(e) => set("maxPrice", e.target.value)} />
                </div>
              </div>

              <div className="field">
                <span className="label">
                  Időpontok <em>{f.weeks.length ? "" : "(bármelyik)"}</em>
                </span>
                <div className="chips">
                  {allWeeks.map(([start, end]) => (
                    <button key={start} className={f.weeks.includes(start) ? "chip on" : "chip"} aria-pressed={f.weeks.includes(start)} onClick={() => set("weeks", toggle(f.weeks, start))}>
                      {fmtDay(start)} – {fmtDay(end)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <span className="label">
                  Síterepek <em>{f.resorts.length ? "" : "(bármelyik)"}</em>
                </span>
                <div className="chips">
                  {data.resorts.map((r) => (
                    <button key={r.id} className={f.resorts.includes(r.id) ? "chip on" : "chip"} aria-pressed={f.resorts.includes(r.id)} onClick={() => set("resorts", toggle(f.resorts, r.id))}>
                      {r.name} <small>{r.km} km</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="field two">
                <div>
                  <label htmlFor="minKm">Min. pályahossz (km)</label>
                  <input id="minKm" type="number" min={0} step={50} placeholder="–" value={f.minKm} onChange={(e) => set("minKm", e.target.value)} />
                </div>
                <div>
                  <label htmlFor="maxDist">Pálya max. (m)</label>
                  <select id="maxDist" value={f.maxDist} onChange={(e) => set("maxDist", e.target.value)}>
                    <option value="">mindegy</option>
                    {[50, 100, 200, 300].map((d) => (
                      <option key={d} value={d}>
                        {d} m-en belül
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="maxCap">Legnagyobb apartman</label>
                <select id="maxCap" value={f.maxCap} onChange={(e) => set("maxCap", e.target.value)}>
                  <option value="">mindegy</option>
                  {[2, 4, 6, 8, 10, 12].map((c) => (
                    <option key={c} value={c}>
                      legfeljebb {c} fős
                    </option>
                  ))}
                </select>
              </div>

              {hasRatings && (
                <div className="field">
                  <label htmlFor="minRating">Google-értékelés</label>
                  <select id="minRating" value={f.minRating} onChange={(e) => set("minRating", e.target.value)}>
                    <option value="">mindegy</option>
                    {[3.5, 4, 4.5].map((r) => (
                      <option key={r} value={r}>
                        legalább {r.toLocaleString("hu-HU", { minimumFractionDigits: 1 })} ★
                      </option>
                    ))}
                  </select>
                  {f.minRating && <p className="hint">Az értékelés nélküli szállások ilyenkor nem látszanak.</p>}
                </div>
              )}

              <label className="check">
                <input type="checkbox" checked={f.noEmpty} onChange={(e) => set("noEmpty", e.target.checked)} />
                Csak üres ágy nélküli beosztás
              </label>
              <label className="check">
                <input type="checkbox" checked={f.course} onChange={(e) => set("course", e.target.checked)} />
                Csak síoktatásos hetek
              </label>

              <button className="reset" onClick={() => setF({ ...DEFAULTS, people: f.people, mode: f.mode })}>
                Szűrők törlése
              </button>
            </aside>

            <section className="results" aria-live="polite">
              <div className="results-head">
                <h2>
                  {offers.length} ajánlat <small>{f.people} főre · {MODE_LABEL[f.mode].toLowerCase()}</small>
                </h2>
                <label className="sort">
                  Rendezés
                  <select value={f.sort} onChange={(e) => set("sort", e.target.value as Sort)}>
                    <option value="price">Legolcsóbb elöl</option>
                    <option value="priceDesc">Legdrágább elöl</option>
                    <option value="date">Időpont szerint</option>
                    <option value="km">Legnagyobb síterep elöl</option>
                    <option value="distance">Pályához legközelebb</option>
                    {hasRatings && <option value="rating">Legjobb értékelés elöl</option>}
                  </select>
                </label>
              </div>

              {offers.length === 0 && (
                <p className="panel notice">
                  Ilyen feltételekkel most nincs szabad hely. Próbálj tágabb árkeretet, több időpontot vagy másik utazási módot.
                </p>
              )}

              {offers.slice(0, shown).map((o) => (
                <OfferCard key={`${o.acc.id}-${o.week.start}`} offer={o} people={f.people} mode={f.mode} events={events} onDetail={setDetail} />
              ))}

              {offers.length > shown && (
                <button className="more" onClick={() => setShown(shown + PAGE)}>
                  További ajánlatok ({offers.length - shown})
                </button>
              )}

              <p className="footnote">
                Az ár a Travelex ártáblázatából számolt, fejenkénti átlag: tartalmazza az üres ágyak díját, de a foglaláskor
                felszámított személyenkénti kezelési díjat (jellemzően 22 €) és a kedvezményeket nem. A táblázat nem mutatja, hány
                apartman maradt egy típusból – a pontos árat és a szabad helyet a Travelex kalkulátora adja meg.
              </p>
            </section>
          </div>
        )}

        {data && tab === "resorts" && (
          <ResortsTab
            resorts={data.resorts}
            onOpen={(resort) => setDetail({ resort })}
            onOffers={(resort) => {
              set("resorts", [resort.id]);
              setTab("offers");
            }}
          />
        )}
        {detail?.acc && <AccommodationDialog resort={detail.resort} acc={detail.acc} rating={ratings[detail.acc.id]} onClose={() => setDetail(null)} />}
        {detail && !detail.acc && <ResortDialog resort={detail.resort} onClose={() => setDetail(null)} />}

        {data && tab === "sellout" && <Sellout data={data} snapshots={snapshots} />}
        {data && tab === "changes" && <Changes events={events} />}
      </main>

      <footer>
        Nem hivatalos oldal, az adatok forrása a{" "}
        <a href="https://travelex.si" target="_blank" rel="noreferrer">
          travelex.si
        </a>
        . Foglalás előtt mindig ellenőrizd az árat az eredeti oldalon.
      </footer>
    </>
  );
}

function OfferCard({ offer, people, mode, events, onDetail }: { offer: Offer; people: number; mode: Mode; events: ChangeEvent[]; onDetail: (d: Detail) => void }) {
  const { resort, acc, week, alloc, fullTypes } = offer;
  const total = Object.keys(week.cells).length;
  const picked = new Set(alloc.picks.map((p) => p.type.key));
  const change = [...events]
    .reverse()
    .find((e) => e.kind === "price" && e.accId === acc.id && e.start === week.start && e.mode === mode && picked.has(e.type));

  return (
    <article className="card">
      <button className="thumb" style={acc.image ? { backgroundImage: `url(${acc.image})` } : undefined} onClick={() => onDetail({ resort, acc })} aria-label={`${acc.name}: képek és részletek`}>
        {(acc.photos?.length ?? 0) > 0 && <span>{acc.photos!.length} kép</span>}
      </button>
      <div className="card-body">
        <button className="where" onClick={() => onDetail({ resort })} title="Sítérkép és a síterep adatai">
          {resort.name} · {resort.km} km pálya{resort.peak ? ` · ${resort.peak} m` : ""} <span aria-hidden="true">›</span>
        </button>
        <h3>
          <button onClick={() => onDetail({ resort, acc })} title="Képek és részletek">
            {acc.name}
          </button>
        </h3>
        <p className="when">{fmtWeek(week.start, week.end)}</p>
        {offer.rating && <Stars rating={offer.rating} />}
        <ul className="facts">
          <li>
            {alloc.picks.map((p) => `${p.count} × ${p.type.label}`).join(" + ")}
            {alloc.emptyBeds > 0 && <span className="muted"> ({alloc.emptyBeds} üres ágy)</span>}
          </li>
          {acc.distance && <li>Pálya: {acc.distance}</li>}
          <li title="Az ezen a héten megtelt apartmantípusok aránya ennél a szállásnál">
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${(fullTypes / total) * 100}%` }} />
            </span>
            {fullTypes}/{total} típus megtelt
          </li>
        </ul>
        <div className="actions">
          <button onClick={() => onDetail({ resort })}>
            <MapIcon /> Sítérkép és pályák
          </button>
          <button onClick={() => onDetail({ resort, acc })}>
            <PhotoIcon /> Képek és a szállás helye
          </button>
        </div>
        {change && change.old != null && change.new != null && (
          <p className={change.new < change.old ? "delta down" : "delta up"}>
            {change.new < change.old ? "↓ Olcsóbb lett" : "↑ Drágább lett"}: {fmtEur(change.old)} → {fmtEur(change.new)} / fő
            <span className="muted"> ({fmtDateTime(change.t)})</span>
          </p>
        )}
      </div>
      <div className="price">
        <strong>{fmtEur(alloc.perPerson)}</strong>
        <span>/ fő</span>
        <em>összesen {fmtEur(alloc.total)}</em>
        <a className="cta" href={bookingUrl(resort, acc, week, alloc, people, mode)} target="_blank" rel="noreferrer">
          Megnézem a Travelexen
        </a>
      </div>
    </article>
  );
}

const icon = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function MapIcon() {
  return (
    <svg {...icon}>
      <path d="M3 19 9 7l4 7 3-4 5 9Z" />
      <path d="m9 7 1.5 3" />
    </svg>
  );
}

function PhotoIcon() {
  return (
    <svg {...icon}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m21 16-5-5-7 8" />
    </svg>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="muted">–</span>;
  const w = 96;
  const h = 24;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const y = (v: number) => (hi === lo ? h / 2 : h - 3 - ((v - lo) / (hi - lo)) * (h - 6));
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 6) + 3).toFixed(1)},${y(v).toFixed(1)}`);
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Megtelt helyek alakulása: ${values[0]} → ${values[values.length - 1]}`}>
      <polyline points={pts.join(" ")} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="3" />
    </svg>
  );
}

function SelloutTable({ rows, snapshots, pick, head }: { rows: { key: string; label: string }[]; snapshots: Snapshot[]; pick: (s: Snapshot, key: string) => [number, number] | undefined; head: string }) {
  const last = snapshots[snapshots.length - 1];
  const weekAgo = Date.parse(last.t) - 7 * 864e5;
  const ref = snapshots.find((s) => Date.parse(s.t) >= weekAgo) ?? last;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{head}</th>
            <th>Megtelt apartmanopciók</th>
            <th className="num">Arány</th>
            <th className="num">Elmúlt 7 nap</th>
            <th>Alakulás</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label }) => {
            const cur = pick(last, key);
            if (!cur) return null;
            const [full, total] = cur;
            const before = pick(ref, key)?.[0];
            const delta = before == null ? 0 : full - before;
            const series = snapshots.map((s) => pick(s, key)?.[0]).filter((v): v is number => v != null);
            return (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td>
                  <span className="meter wide" title={`${full} megtelt, ${total - full} szabad`}>
                    <span style={{ width: `${(full / total) * 100}%` }} />
                  </span>
                  <span className="frac">
                    {full} / {total}
                  </span>
                </td>
                <td className="num">{Math.round((full / total) * 100)}%</td>
                <td className="num">
                  {delta === 0 ? <span className="muted">nincs változás</span> : delta > 0 ? `+${delta} megtelt` : `${-delta} felszabadult`}
                </td>
                <td>
                  <Sparkline values={series} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Sellout({ data, snapshots }: { data: Data; snapshots: Snapshot[] }) {
  if (!snapshots.length) return <p className="panel notice">Még nincs telítettségi adat.</p>;
  const last = snapshots[snapshots.length - 1];
  const weeks = Object.keys(last.weeks).map((start) => {
    const d = new Date(start + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 7);
    return { key: start, label: `${start.slice(0, 4)}. ${fmtDay(start)} – ${fmtDay(d.toISOString().slice(0, 10))}` };
  });
  const resorts = data.resorts.map((r) => ({ key: String(r.id), label: r.name }));
  return (
    <section className="panel">
      <h2>Hogyan fogynak a helyek?</h2>
      <p className="muted intro">
        Egy „apartmanopció” egy szállás egy apartmantípusa egy adott héten. Az arány azt mutatja, ezek közül mennyi telt már be.
        {snapshots.length < 2 && " A trend az első néhány frissítés után jelenik meg – a figyelés " + fmtDateTime(snapshots[0].t) + "-kor indult."}
      </p>
      <h3>Hetek szerint</h3>
      <SelloutTable rows={weeks} snapshots={snapshots} pick={(s, k) => s.weeks[k]} head="Hét" />
      <h3>Síterepek szerint</h3>
      <SelloutTable rows={resorts} snapshots={snapshots} pick={(s, k) => s.resorts[k]} head="Síterep" />
    </section>
  );
}

const KIND_LABEL = { price: "Árváltozás", soldout: "Megtelt", reopened: "Újra szabad" } as const;

function Changes({ events }: { events: ChangeEvent[] }) {
  const [kind, setKind] = useState<"all" | ChangeEvent["kind"]>("all");
  const list = useMemo(() => [...events].reverse().filter((e) => kind === "all" || e.kind === kind), [events, kind]);
  return (
    <section className="panel">
      <h2>Ár- és helyváltozások</h2>
      <div className="chips kinds">
        {(["all", "price", "soldout", "reopened"] as const).map((k) => (
          <button key={k} className={kind === k ? "chip on" : "chip"} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === "all" ? "Mind" : KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="muted intro">
          Még nincs rögzített változás. Az oldal néhány óránként újraolvassa a Travelex árait, és itt listázza, ha egy ár módosul, egy
          apartman megtelik vagy újra felszabadul.
        </p>
      ) : (
        <ul className="events">
          {list.slice(0, 300).map((e, i) => (
            <li key={i}>
              <time>{fmtDateTime(e.t)}</time>
              <div>
                <strong>
                  {e.resort} · {e.acc}
                </strong>
                <span className="muted">
                  {" "}
                  {fmtWeek(e.start, e.end)} · {e.type} fős{e.mode ? ` · ${MODE_LABEL[e.mode].toLowerCase()}` : ""}
                </span>
                <br />
                {e.kind === "price" && e.old != null && e.new != null && (
                  <span className={e.new < e.old ? "delta down" : "delta up"}>
                    {e.new < e.old ? "↓ Olcsóbb" : "↑ Drágább"}: {fmtEur(e.old)} → {fmtEur(e.new)} ({e.new > e.old ? "+" : "−"}
                    {fmtEur(Math.abs(e.new - e.old))})
                  </span>
                )}
                {e.kind === "soldout" && <span className="delta up">● Megtelt</span>}
                {e.kind === "reopened" && <span className="delta down">○ Újra szabad{e.new != null ? ` – ${fmtEur(e.new)} / fő` : ""}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Mountains() {
  return (
    <svg className="mountains" viewBox="0 0 1440 260" preserveAspectRatio="none" aria-hidden="true">
      <path className="m3" d="M0 150 L140 70 L250 130 L390 30 L520 120 L660 60 L800 140 L960 50 L1100 130 L1250 80 L1440 150 V260 H0Z" />
      <path className="m2" d="M0 190 L180 120 L330 180 L500 100 L690 185 L860 125 L1040 190 L1210 130 L1440 195 V260 H0Z" />
      <path className="m1" d="M0 225 C200 180 380 240 600 210 C820 180 1000 245 1200 215 C1300 200 1380 215 1440 225 V260 H0Z" />
      {[120, 310, 540, 780, 990, 1230].map((x, i) => (
        <g key={x} className="lamp" transform={`translate(${x} ${212 + (i % 2) * 8})`}>
          <circle r="14" className="glow" />
          <circle r="3" />
        </g>
      ))}
    </svg>
  );
}
