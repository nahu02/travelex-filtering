export type Mode = "car" | "bus" | "flight";

export interface Cell {
  full?: boolean;
  list?: number | null;
  car?: number | null;
  bus?: number | null;
  flight?: number | null;
  fee?: number | null;
  soldOut?: Mode[];
}

export interface AptType {
  key: string;
  label: string;
  capacity: number;
}

export interface Week {
  start: string;
  end: string;
  bus: boolean;
  flight: boolean;
  cells: Record<string, Cell>;
}

export interface Accommodation {
  id: number;
  slug: string | null;
  name: string;
  subtitle: string | null;
  distance: string | null;
  distanceM: number | null;
  image: string | null;
  url?: string;
  photos?: { src: string; thumb: string; caption: string | null }[];
  /** Piste map with this accommodation's location marked (not available everywhere). */
  pisteMap?: string | null;
  townMap?: string | null;
  gmaps?: string | null;
  types: AptType[];
  weeks: Week[];
}

export interface Resort {
  id: number;
  name: string;
  url: string;
  image: string | null;
  km: number | null;
  kmByColor: Record<string, number | null>;
  peak: number | null;
  height: string | null;
  lifts?: Record<string, number>;
  map?: string | null;
  programs?: string | null;
  video?: string | null;
  website?: string | null;
  courseWeeks: string[];
  accommodations: Accommodation[];
}

export interface Data {
  scrapedAt: string;
  source: string;
  resorts: Resort[];
}

export interface ChangeEvent {
  t: string;
  resortId: number;
  accId: number;
  resort: string;
  acc: string;
  start: string;
  end: string;
  type: string;
  kind: "price" | "soldout" | "reopened";
  mode?: Mode;
  old?: number;
  new?: number;
}

export interface Snapshot {
  t: string;
  weeks: Record<string, [number, number]>;
  resorts: Record<string, [number, number]>;
}

export interface Rating {
  rating: number | null;
  count?: number;
  url?: string | null;
}

export interface Pick {
  type: AptType;
  count: number;
  /** Per-person price for the chosen travel mode. */
  price: number;
}

export interface Allocation {
  total: number;
  perPerson: number;
  emptyBeds: number;
  picks: Pick[];
}

interface Option {
  type: AptType;
  price: number;
  fee: number;
}

/**
 * Cheapest way to house `people` in the apartments still bookable for a week.
 *
 * Pricing follows the travelex.si calculator: every traveller pays the per-person
 * price of their apartment, and every unused bed costs that apartment's empty-bed fee.
 * The site does not publish how many apartments of a type are left, so a type that is
 * not sold out is assumed to be bookable as many times as needed.
 */
export function allocate(
  week: Week,
  types: AptType[],
  people: number,
  mode: Mode,
  opts: { maxCapacity?: number; noEmptyBeds?: boolean } = {},
): Allocation | null {
  if (people < 1) return null;
  const options: Option[] = [];
  for (const type of types) {
    const cell = week.cells[type.key];
    if (!cell || cell.full || !type.capacity) continue;
    if (opts.maxCapacity && type.capacity > opts.maxCapacity) continue;
    const price = cell[mode];
    if (price == null) continue;
    options.push({ type, price, fee: cell.fee ?? 0 });
  }
  if (!options.length) return null;

  type State = { cost: number; empty: number; prev: number; opt: Option } | null;
  const best: State[] = new Array(people + 1).fill(null);
  for (let n = 1; n <= people; n++) {
    for (const opt of options) {
      const cap = opt.type.capacity;
      const from = opts.noEmptyBeds ? cap : 1;
      for (let k = from; k <= Math.min(cap, n); k++) {
        const prev = n - k;
        const base = prev === 0 ? { cost: 0, empty: 0 } : best[prev];
        if (!base) continue;
        const cost = base.cost + k * opt.price + (cap - k) * opt.fee;
        const empty = base.empty + (cap - k);
        const cur = best[n];
        if (!cur || cost < cur.cost || (cost === cur.cost && empty < cur.empty)) {
          best[n] = { cost, empty, prev, opt };
        }
      }
    }
  }
  const end = best[people];
  if (!end) return null;

  const counts = new Map<string, Pick>();
  for (let n = people; n > 0; ) {
    const s = best[n]!;
    const pick = counts.get(s.opt.type.key);
    if (pick) pick.count++;
    else counts.set(s.opt.type.key, { type: s.opt.type, count: 1, price: s.opt.price });
    n = s.prev;
  }
  const picks = [...counts.values()].sort((a, b) => a.type.capacity - b.type.capacity);
  return { total: end.cost, perPerson: end.cost / people, emptyBeds: end.empty, picks };
}

const PERSON_FIELD: Record<Mode, string> = {
  car: "custom_persons",
  bus: "bus_persons",
  flight: "flight_persons",
};

/** Link that opens the travelex.si price calculator pre-filled with this selection. */
export function bookingUrl(
  resort: Resort,
  acc: Accommodation,
  week: Week,
  alloc: Allocation,
  people: number,
  mode: Mode,
): string {
  const payload = {
    shop_category_id: String(resort.id),
    product_id: String(acc.id),
    timeslot: `${week.start} - ${week.end}`,
    apartman_types: alloc.picks.map((p) => p.type.key),
    apartman_quantity: alloc.picks.map((p) => String(p.count)),
    [PERSON_FIELD[mode]]: String(people),
    tab_index: 0,
    show_details: 1,
  };
  // The site encodes non-ASCII characters as \uXXXX escapes (PHP json_encode); mirror that.
  const json = JSON.stringify(payload).replace(
    /[\u0080-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const hash = encodeURIComponent(btoa(json));
  return `${resort.url}/szallas?hash=${hash}${acc.slug ? "#" + acc.slug : ""}`;
}

const MONTHS = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];

export function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}.`;
}

export function fmtWeek(start: string, end: string): string {
  return `${start.slice(0, 4)}. ${fmtDay(start)} – ${fmtDay(end)}`;
}

export function fmtEur(n: number): string {
  return `${Math.round(n).toLocaleString("hu-HU")} €`;
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("hu-HU", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const MODE_LABEL: Record<Mode, string> = {
  car: "Egyéni utazás",
  bus: "Busz",
  flight: "Repülő",
};
