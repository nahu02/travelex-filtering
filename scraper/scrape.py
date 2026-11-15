#!/usr/bin/env python3
"""Scrape travelex.si ski trips into JSON for the static filtering UI.

Writes three files into the output directory:
  data.json     current resorts / accommodations / weekly prices and availability
  events.json   append-only log of price changes and sold-out transitions
  sellout.json  time series of how many apartment options are sold out per week

Usage: python scraper/scrape.py [--out web/public/data] [--from-dir DIR]
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE = "https://travelex.si"
LIST_URL = f"{BASE}/siutjaink"
UA = "Mozilla/5.0 (compatible; travelex-filter/1.0)"
MAX_EVENTS = 5000
MAX_SNAPSHOTS = 2000
MODES = ("car", "bus", "flight")

# Official resort websites are not on travelex.si, so they are maintained here by resort id.
# A resort missing from this table simply gets a web-search link in the UI.
WEBSITES = {
    12: "https://www.lesorres.com",
    2: "https://isola2000.com",
    8: "https://www.les2alpes.com",
    9: "https://www.serre-chevalier.com",
    10: "https://www.alpedhuez.com",
    1: "https://www.tignes.net",
    13: "https://www.sybelles.ski",
    25: "https://montgenevre.com",
    19: "https://paradiski.com",
    14: "https://www.saintgervais.com",
    16: "https://www.les3vallees.com",
}


def storage_url(path: str | None) -> str | None:
    if not path:
        return None
    return path if path.startswith("http") else f"{BASE}/storage/{path.lstrip('/')}"


def fetch(session: requests.Session, url: str) -> str:
    for attempt in range(4):
        try:
            r = session.get(url, timeout=60)
            r.raise_for_status()
            r.encoding = "utf-8"
            return r.text
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))
    raise AssertionError("unreachable")


def num(value) -> float | int | None:
    if value is None:
        return None
    m = re.search(r"\d+(?:[.,]\d+)?", str(value).replace("\xa0", "").replace(" ", ""))
    if not m:
        return None
    f = float(m.group(0).replace(",", "."))
    return int(f) if f.is_integer() else f


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def iso_period(period: str) -> tuple[str, str]:
    dates = re.findall(r"(\d{4})[.\-](\d{2})[.\-](\d{2})", period)
    if len(dates) != 2:
        raise ValueError(f"unexpected period: {period!r}")
    return "-".join(dates[0]), "-".join(dates[1])


def parse_resorts(page: str) -> list[dict]:
    m = re.search(r'ng-init="([^"]*SCS\.setCategories[^"]*)"', page)
    if not m:
        raise ValueError("resort list not found on listing page")
    m = re.search(r"SCS\.setCategories\((\[.*\])\)", html.unescape(m.group(1)), re.S)
    cats = json.loads(m.group(1))
    resorts = []
    for c in cats:
        p = c.get("parameters") or {}
        track = p.get("tracklength") or {}
        docs = p.get("documents") or {}
        lift = p.get("lift") or {}
        course_weeks = sorted(
            {iso_period(d["date"])[0] for d in c.get("dates", []) if d.get("course")}
        )
        resorts.append(
            {
                "id": c["id"],
                "name": c.get("short_name") or c["name"],
                "url": c["url"],
                "image": c.get("thumb_image_url"),
                "km": num(track.get("sum")),
                "kmByColor": {
                    k: num(track.get(k)) for k in ("green", "blue", "red", "black")
                },
                "peak": num(p.get("peak")),
                "height": p.get("height"),
                "lifts": {
                    k: num(lift.get(k)) or 0 for k in ("cabine", "seating", "pulling", "railway")
                },
                "map": storage_url(docs.get("map")),
                "programs": storage_url(docs.get("programs")),
                "video": p.get("youtube_link"),
                "website": WEBSITES.get(c["id"]),
                "courseWeeks": course_weeks,
                "accommodations": [],
            }
        )
    return resorts


def parse_price(cell, cls: str) -> tuple[float | int | None, bool]:
    """Return (price, sold_out) for one price variant inside a table cell."""
    el = cell.select_one(f".price-{cls}")
    if el is None:
        return None, False
    if "Megtelt" in el.get_text():
        return None, True
    return num(el.get_text()), False


def parse_type(th) -> dict:
    # Header looks like "T: 6 x" / "6 fős: Tágas" (desktop / mobile variants).
    desktop = th.select_one("span.d-none")
    mobile = th.select_one("span.d-lg-none")
    key = clean(desktop.get_text()).removesuffix("x").strip() if desktop else clean(th.get_text())
    label = clean(mobile.get_text()) if mobile else key
    caps = re.findall(r"\d+", key.split(":")[-1])
    return {"key": key, "label": label, "capacity": int(caps[-1]) if caps else None}


def find_link(sec, *needles: str) -> str | None:
    for a in sec.select("a[href]") if sec else []:
        label = clean(a.get_text()).lower()
        if any(n in label for n in needles):
            return a["href"]
    return None


def parse_photos(sec) -> list[dict]:
    photos = []
    for li in sec.select("li[data-thumb]") if sec else []:
        a = li.find("a", href=True)
        if a:
            photos.append(
                {"src": a["href"], "thumb": li["data-thumb"], "caption": clean(li.get_text(" ")) or None}
            )
    return photos


def parse_accommodations(page: str, resort_url: str = "") -> list[dict]:
    soup = BeautifulSoup(page, "lxml")
    out = []
    for table in soup.select("table[id^=pricesTable]"):
        acc_id = int(table["id"].removeprefix("pricesTable"))
        sec = table.find_parent(lambda t: t.name == "div" and t.get("id") and t.find("h2"))
        name = clean(sec.h2.get_text()) if sec else f"#{acc_id}"
        name = re.sub(r"^Szállás\s*\d+\s*-\s*", "", name)
        text = sec.get_text(" ", strip=True) if sec else ""
        dist = re.search(r"Távolság a sípályáktól:\s*([\d\s\-–]+m)", text)
        thumb = sec.select_one("li[data-thumb]") if sec else None
        subtitle = sec.select_one("h5") if sec else None
        types = [parse_type(th) for th in table.select("thead th")[1:]]
        weeks = []
        for tr in table.select("tbody tr"):
            date_td = tr.select_one("td.timeslot-dates")
            if date_td is None:
                continue
            start, end = iso_period(date_td.get("data-period", ""))
            classes = tr.get("class") or []
            cells = {}
            for t, td in zip(types, tr.select("td.timeslot-price")):
                td_classes = td.get("class") or []
                fee = num(getattr(td.select_one(".price-add-fee"), "text", None))
                if "full" in td_classes:
                    cells[t["key"]] = {"full": True, "list": num(td.get("data-price"))}
                    continue
                car, car_full = parse_price(td, "car")
                if car is None and not car_full:
                    car, car_full = parse_price(td, "default")
                bus, bus_full = parse_price(td, "bus")
                flight, flight_full = parse_price(td, "flight")
                cell = {"car": car, "bus": bus, "flight": flight, "fee": fee}
                sold = [m for m, f in zip(MODES, (car_full, bus_full, flight_full)) if f]
                if sold:
                    cell["soldOut"] = sold
                if car is None and bus is None and flight is None:
                    cell = {"full": True, "list": None}
                cells[t["key"]] = cell
            weeks.append(
                {
                    "start": start,
                    "end": end,
                    "bus": "timeslot-bus" in classes,
                    "flight": "timeslot-flight" in classes,
                    "cells": cells,
                }
            )
        out.append(
            {
                "id": acc_id,
                "slug": sec.get("id") if sec else None,
                "name": name,
                "subtitle": clean(subtitle.get_text()) if subtitle else None,
                "distance": clean(dist.group(1)) if dist else None,
                "distanceM": num(re.split(r"[-–]", dist.group(1))[-1]) if dist else None,
                "image": thumb.get("data-thumb") if thumb else None,
                "url": f"{resort_url}/szallas" + (f"#{sec.get('id')}" if sec else ""),
                "photos": parse_photos(sec),
                "townMap": find_link(sec, "várostérkép"),
                "gmaps": find_link(sec, "google térkép", "google maps"),
                "types": types,
                "weeks": weeks,
            }
        )
    return out


def flatten(data: dict) -> dict[tuple, dict]:
    flat = {}
    for r in data["resorts"]:
        for a in r["accommodations"]:
            for w in a["weeks"]:
                for key, cell in w["cells"].items():
                    flat[(r["id"], a["id"], w["start"], key)] = {
                        "cell": cell,
                        "resort": r["name"],
                        "acc": a["name"],
                        "end": w["end"],
                    }
    return flat


def diff_events(old: dict, new: dict, ts: str) -> list[dict]:
    """Compare two scrapes and describe what changed, cell by cell."""
    before, after = flatten(old), flatten(new)
    events = []
    for k, cur in after.items():
        prev = before.get(k)
        if prev is None:
            continue  # new weeks / accommodations are not "changes" worth logging
        a, b = prev["cell"], cur["cell"]
        base = {
            "t": ts,
            "resortId": k[0],
            "accId": k[1],
            "resort": cur["resort"],
            "acc": cur["acc"],
            "start": k[2],
            "end": cur["end"],
            "type": k[3],
        }
        if a.get("full") and b.get("full"):
            continue
        if b.get("full"):
            events.append({**base, "kind": "soldout"})
            continue
        if a.get("full"):
            events.append({**base, "kind": "reopened", "new": b.get("car") or b.get("bus")})
            continue
        for mode in MODES:
            pa, pb = a.get(mode), b.get(mode)
            was_sold = mode in a.get("soldOut", [])
            is_sold = mode in b.get("soldOut", [])
            if is_sold and not was_sold:
                events.append({**base, "kind": "soldout", "mode": mode})
            elif was_sold and not is_sold and pb is not None:
                events.append({**base, "kind": "reopened", "mode": mode, "new": pb})
            elif pa is not None and pb is not None and pa != pb:
                events.append({**base, "kind": "price", "mode": mode, "old": pa, "new": pb})
    return events


def sellout_snapshot(data: dict, ts: str) -> dict:
    weeks: dict[str, list[int]] = {}
    resorts: dict[str, list[int]] = {}
    for r in data["resorts"]:
        for a in r["accommodations"]:
            for w in a["weeks"]:
                for cell in w["cells"].values():
                    full = 1 if cell.get("full") else 0
                    for bucket, key in ((weeks, w["start"]), (resorts, str(r["id"]))):
                        entry = bucket.setdefault(key, [0, 0])
                        entry[0] += full
                        entry[1] += 1
    return {"t": ts, "weeks": dict(sorted(weeks.items())), "resorts": resorts}


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def dump(path: Path, obj) -> None:
    path.write_text(
        json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="web/public/data", type=Path)
    ap.add_argument("--from-dir", type=Path, help="read saved HTML instead of the network (for testing)")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    args = ap.parse_args()

    session = requests.Session()
    session.headers["User-Agent"] = UA

    def get(url: str, name: str) -> str:
        if args.from_dir:
            return (args.from_dir / name).read_text(encoding="utf-8", errors="replace")
        time.sleep(args.delay)
        return fetch(session, url)

    resorts = parse_resorts(get(LIST_URL, "siutjaink.html"))
    for r in resorts:
        slug = r["url"].rstrip("/").rsplit("/", 1)[-1]
        r["accommodations"] = parse_accommodations(
            get(f"{r['url']}/szallas", f"sz_{slug}.html"), r["url"]
        )
        print(f"{r['name']}: {len(r['accommodations'])} szállás", file=sys.stderr)

    n_cells = sum(len(w["cells"]) for r in resorts for a in r["accommodations"] for w in a["weeks"])
    if len(resorts) < 3 or n_cells < 50:
        # Guard against the site layout changing: never overwrite good data with an empty scrape.
        print(f"Suspiciously little data ({len(resorts)} resorts, {n_cells} cells); aborting.", file=sys.stderr)
        return 1

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = {"scrapedAt": ts, "source": BASE, "resorts": resorts}

    args.out.mkdir(parents=True, exist_ok=True)
    data_path, events_path, sellout_path = (args.out / n for n in ("data.json", "events.json", "sellout.json"))

    previous = load(data_path, None)
    events = load(events_path, [])
    if previous:
        new_events = diff_events(previous, data, ts)
        print(f"{len(new_events)} változás", file=sys.stderr)
        events = (events + new_events)[-MAX_EVENTS:]

    snapshots = load(sellout_path, [])
    snap = sellout_snapshot(data, ts)
    if not snapshots or any(snapshots[-1][k] != snap[k] for k in ("weeks", "resorts")):
        snapshots = (snapshots + [snap])[-MAX_SNAPSHOTS:]

    dump(data_path, data)
    dump(events_path, events)
    dump(sellout_path, snapshots)
    print(f"OK: {len(resorts)} síterep, {n_cells} ár-cella → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
