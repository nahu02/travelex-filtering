#!/usr/bin/env python3
"""Fetch Google Maps ratings for the accommodations that have a Maps link on travelex.si.

Uses the official Places API (New) Text Search, so it needs an API key in the
GOOGLE_MAPS_API_KEY environment variable. Without a key it does nothing and exits 0,
which leaves the site working without ratings.

Each accommodation's Maps link is resolved to the place name and coordinates, and the
place is looked up by that name near those coordinates. Results are kept in
ratings.json and only refreshed when older than --max-age-days.

Usage: python scraper/ratings.py [--data web/public/data] [--max-age-days 7]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote_plus, urljoin

import requests

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
FIELDS = ["places.id", "places.displayName", "places.rating", "places.userRatingCount", "places.googleMapsUri", "places.location"]
MAX_DISTANCE_M = 600  # a match further than this from the Travelex pin is treated as the wrong place
REVIEWS_FIELD = "places.googleMapsLinks.reviewsUri"
UA = "Mozilla/5.0 (compatible; travelex-filter/1.0)"
TS = "%Y-%m-%dT%H:%M:%SZ"


def parse_place_url(url: str) -> dict | None:
    """Pull the place name and coordinates out of a full Google Maps place URL."""
    m = re.search(r"/maps/place/([^/@?]+)", url)
    if not m:
        return None
    # "!3d<lat>!4d<lng>" is the pin itself; "@lat,lng" is only the viewport centre.
    pin = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", url) or re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", url)
    if not pin:
        return None
    return {"name": unquote_plus(m.group(1)), "lat": float(pin.group(1)), "lng": float(pin.group(2))}


def resolve(session: requests.Session, url: str) -> dict | None:
    """Follow a (possibly shortened) Maps link until it becomes a place URL."""
    for _ in range(6):
        place = parse_place_url(url)
        if place:
            return place
        r = session.get(url, allow_redirects=False, timeout=30)
        location = r.headers.get("Location")
        if not location:
            return None
        url = urljoin(url, location)
    return parse_place_url(url)


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


def queries(place: dict, acc_name: str, resort_name: str) -> list[str]:
    """Search texts to try, best first.

    Some Travelex links are bare coordinate pins ("44°11'08.4\"N 7°09'34.3\"E") rather than
    places; for those, and as a fallback, search by the accommodation's own name.
    """
    own = re.sub(r"\*+", "", acc_name.split(" - ")[0]).strip() + " " + resort_name
    is_pin = bool(re.match(r"^\s*-?\d+[°.]", place["name"]))
    return [own] if is_pin else [place["name"], own]


def lookup(session: requests.Session, key: str, query: str, place: dict) -> dict | None:
    body = {
        "textQuery": query,
        "pageSize": 1,
        "languageCode": "hu",
        "locationBias": {
            "circle": {"center": {"latitude": place["lat"], "longitude": place["lng"]}, "radius": 300.0}
        },
    }
    # The reviews deep link is a newer field; fall back to the basic set if it is rejected.
    for fields in (FIELDS + [REVIEWS_FIELD], FIELDS):
        r = session.post(
            SEARCH_URL,
            json=body,
            headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": ",".join(fields)},
            timeout=30,
        )
        if r.status_code != 400:
            break
    r.raise_for_status()
    places = r.json().get("places") or []
    if not places:
        return None
    p = places[0]
    loc = p.get("location") or {}
    if "latitude" in loc and distance_m(place["lat"], place["lng"], loc["latitude"], loc["longitude"]) > MAX_DISTANCE_M:
        return None
    if p.get("rating") is None:
        return None
    return {
        "placeId": p.get("id"),
        "name": (p.get("displayName") or {}).get("text"),
        "rating": p["rating"],
        "count": p.get("userRatingCount", 0),
        "url": (p.get("googleMapsLinks") or {}).get("reviewsUri") or p.get("googleMapsUri"),
    }


def update(data: dict, ratings: dict, key: str, session: requests.Session, max_age: timedelta, now: datetime, delay: float = 0.2) -> dict:
    """Return ratings refreshed for every accommodation with a Maps link.

    A lookup that fails keeps the previous value, so a transient error never wipes ratings.
    """
    out = {}
    for resort in data["resorts"]:
        for acc in resort["accommodations"]:
            aid, link = str(acc["id"]), acc.get("gmaps")
            if not link:
                continue
            old = ratings.get(aid)
            fresh = (
                old
                and old.get("rating") is not None  # misses are cheap to retry and may start matching
                and old.get("link") == link
                and now - datetime.strptime(old["checkedAt"], TS).replace(tzinfo=timezone.utc) < max_age
            )
            if fresh:
                out[aid] = old
                continue
            found, failed = None, False
            try:
                place = resolve(session, link)
            except requests.RequestException as e:
                print(f"{acc['name']}: {e}", file=sys.stderr)
                place, failed = None, True
            for query in queries(place, acc["name"], resort.get("name", "")) if place else []:
                try:
                    found = lookup(session, key, query, place)
                except requests.RequestException as e:
                    print(f"{acc['name']} ({query!r}): {e}", file=sys.stderr)
                    failed = True
                time.sleep(delay)
                if found:
                    break
            if not found and failed:
                if old:
                    out[aid] = old
                continue
            # "rating": None records "looked up, nothing found" so it is not retried every run.
            out[aid] = {**(found or {"rating": None}), "link": link, "checkedAt": now.strftime(TS)}
            print(f"{acc['name']}: {found['rating'] if found else 'nincs értékelés'}", file=sys.stderr)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default="web/public/data", type=Path)
    ap.add_argument("--max-age-days", type=float, default=7)
    args = ap.parse_args()

    key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if not key:
        print("GOOGLE_MAPS_API_KEY nincs beállítva – az értékelések kimaradnak.", file=sys.stderr)
        return 0

    path = args.data / "ratings.json"
    data = json.loads((args.data / "data.json").read_text(encoding="utf-8"))
    try:
        ratings = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        ratings = {}

    session = requests.Session()
    session.headers["User-Agent"] = UA
    new = update(data, ratings, key, session, timedelta(days=args.max_age_days), datetime.now(timezone.utc))
    path.write_text(json.dumps(new, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
    print(f"OK: {sum(1 for r in new.values() if r.get('rating'))} értékelés", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
