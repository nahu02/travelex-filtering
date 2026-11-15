import { describe, expect, it } from "vitest";
import { allocate, bookingUrl, type AptType, type Week } from "./lib";

const types: AptType[] = [
  { key: "4", label: "4 fős", capacity: 4 },
  { key: "T: 6", label: "6 fős: Tágas", capacity: 6 },
  { key: "8", label: "8 fős", capacity: 8 },
];

const week: Week = {
  start: "2027-01-09",
  end: "2027-01-16",
  bus: true,
  flight: false,
  cells: {
    "4": { car: 480, bus: 610, flight: null, fee: 200 },
    "T: 6": { car: 430, bus: 560, flight: null, fee: 150 },
    "8": { full: true, list: 400 },
  },
};

describe("allocate", () => {
  it("matches the travelex calculator for a partly filled apartment", () => {
    // Verified against the site: 3 people in a 4-bed at 455 € + 190 € empty-bed fee.
    const w: Week = { ...week, cells: { "4": { car: 455, bus: null, flight: null, fee: 190 } } };
    const a = allocate(w, types, 3, "car")!;
    expect(a.total).toBe(3 * 455 + 190);
    expect(a.emptyBeds).toBe(1);
  });

  it("picks the cheapest combination and skips sold-out types", () => {
    const a = allocate(week, types, 10, "bus")!;
    // 6-bed full (6×560) + 4-bed full (4×610) beats two 6-beds with two empty beds.
    expect(a.total).toBe(6 * 560 + 4 * 610);
    expect(a.picks.map((p) => [p.type.key, p.count])).toEqual([["4", 1], ["T: 6", 1]]);
    expect(a.emptyBeds).toBe(0);
  });

  it("returns null when the travel mode is not offered", () => {
    expect(allocate(week, types, 4, "flight")).toBeNull();
  });

  it("honours the no-empty-beds and max-capacity options", () => {
    expect(allocate(week, types, 5, "car", { noEmptyBeds: true })).toBeNull();
    const a = allocate(week, types, 6, "car", { maxCapacity: 4 })!;
    expect(a.picks).toHaveLength(1);
    expect(a.picks[0].count).toBe(2);
    expect(a.total).toBe(6 * 480 + 2 * 200);
  });
});

describe("bookingUrl", () => {
  it("builds the same hash the site produces", () => {
    const a = allocate(week, types, 10, "bus")!;
    const url = bookingUrl(
      { id: 8, url: "https://travelex.si/x" } as never,
      { id: 49, slug: "hameaul2a" } as never,
      week,
      a,
      10,
      "bus",
    );
    const hash = decodeURIComponent(url.split("hash=")[1].split("#")[0]);
    expect(JSON.parse(atob(hash))).toMatchObject({
      shop_category_id: "8",
      product_id: "49",
      timeslot: "2027-01-09 - 2027-01-16",
      apartman_types: ["4", "T: 6"],
      apartman_quantity: ["1", "1"],
      bus_persons: "10",
    });
    expect(url.endsWith("#hameaul2a")).toBe(true);
  });
});
