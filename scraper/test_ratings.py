"""Offline tests for ratings.py (no network, no API key). Run: python -m unittest discover scraper"""
import unittest
from datetime import datetime, timedelta, timezone

import ratings

PLACE_URL = (
    "https://www.google.hu/maps/place/Residence+L'Edelweiss+-+Vacanc%C3%A9ole/@45.0144024,6.1242621,17z/"
    "data=!4m8!3m7!1s0x478a12dd263e23f1:0xe6dc0ae0a90e71f!5m2!4m1!1i2!8m2!3d45.0145669!4d6.124952?hl=hu"
)
NOW = datetime(2026, 11, 15, tzinfo=timezone.utc)


class Resp:
    def __init__(self, status=200, headers=None, body=None):
        self.status_code, self.headers, self._body = status, headers or {}, body or {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise ratings.requests.HTTPError(str(self.status_code))


class FakeSession:
    def __init__(self, reject_reviews_field=False, target=PLACE_URL, unknown=(), location=None):
        self.posts, self.gets, self.reject = [], [], reject_reviews_field
        self.target, self.unknown = target, unknown
        self.location = location or {"latitude": 45.0146, "longitude": 6.1250}

    def get(self, url, **kw):
        self.gets.append(url)
        return Resp(302, {"Location": self.target})

    def post(self, url, json, headers, **kw):
        self.posts.append((json, headers))
        if self.reject and ratings.REVIEWS_FIELD in headers["X-Goog-FieldMask"]:
            return Resp(400)
        if json["textQuery"] in self.unknown:
            return Resp(200, body={})
        place = {"id": "abc", "displayName": {"text": "Edelweiss"}, "rating": 4.1, "userRatingCount": 212, "googleMapsUri": "https://maps.google.com/?cid=1", "location": self.location}
        if not self.reject:
            place["googleMapsLinks"] = {"reviewsUri": "https://maps.google.com/reviews"}
        return Resp(200, body={"places": [place]})


PIN_URL = "https://www.google.hu/maps/place/45%C2%B000'21.4%22N+6%C2%B007'13.3%22E/@45.0059493,6.1196232,17z/data=!4m5!3m4!1s0x0:0x0!8m2!3d45.0059444!4d6.1203611?hl=hu"

DATA = {"resorts": [{"name": "Les 2 Alpes", "accommodations": [
    {"id": 20, "name": "Edelweiss**", "gmaps": "https://goo.gl/maps/x"},
    {"id": 19, "name": "Egyedi apartmanok", "gmaps": None},
]}]}


class RatingsTest(unittest.TestCase):
    def test_parse_place_url_uses_pin_coordinates(self):
        p = ratings.parse_place_url(PLACE_URL)
        self.assertEqual(p, {"name": "Residence L'Edelweiss - Vacancéole", "lat": 45.0145669, "lng": 6.124952})
        self.assertIsNone(ratings.parse_place_url("https://goo.gl/maps/x"))

    def test_update_resolves_short_link_and_stores_rating(self):
        s = FakeSession()
        out = ratings.update(DATA, {}, "KEY", s, timedelta(days=7), NOW, delay=0)
        self.assertEqual(list(out), ["20"])
        self.assertEqual(out["20"]["rating"], 4.1)
        self.assertEqual(out["20"]["count"], 212)
        self.assertEqual(out["20"]["url"], "https://maps.google.com/reviews")
        body, headers = s.posts[0]
        self.assertEqual(body["textQuery"], "Residence L'Edelweiss - Vacancéole")
        self.assertEqual(body["locationBias"]["circle"]["center"], {"latitude": 45.0145669, "longitude": 6.124952})
        self.assertEqual(headers["X-Goog-Api-Key"], "KEY")

    def test_falls_back_when_reviews_field_is_rejected(self):
        s = FakeSession(reject_reviews_field=True)
        out = ratings.update(DATA, {}, "KEY", s, timedelta(days=7), NOW, delay=0)
        self.assertEqual(len(s.posts), 2)
        self.assertEqual(out["20"]["url"], "https://maps.google.com/?cid=1")

    def test_coordinate_pin_is_searched_by_accommodation_name(self):
        s = FakeSession(target=PIN_URL, location={"latitude": 45.0060, "longitude": 6.1204})
        out = ratings.update(DATA, {}, "KEY", s, timedelta(days=7), NOW, delay=0)
        self.assertEqual([b["textQuery"] for b, _ in s.posts], ["Edelweiss Les 2 Alpes"])
        self.assertEqual(out["20"]["rating"], 4.1)

    def test_falls_back_to_accommodation_name_when_google_name_finds_nothing(self):
        s = FakeSession(unknown={"Residence L'Edelweiss - Vacancéole"})
        out = ratings.update(DATA, {}, "KEY", s, timedelta(days=7), NOW, delay=0)
        self.assertEqual([b["textQuery"] for b, _ in s.posts][-1], "Edelweiss Les 2 Alpes")
        self.assertEqual(out["20"]["rating"], 4.1)

    def test_match_far_from_the_pin_is_rejected_and_retried_next_run(self):
        s = FakeSession(location={"latitude": 45.10, "longitude": 6.12})
        out = ratings.update(DATA, {}, "KEY", s, timedelta(days=7), NOW, delay=0)
        self.assertIsNone(out["20"]["rating"])
        near = FakeSession()
        self.assertEqual(ratings.update(DATA, out, "KEY", near, timedelta(days=7), NOW, delay=0)["20"]["rating"], 4.1)

    def test_fresh_entries_are_not_refetched(self):
        s = FakeSession()
        old = {"20": {"rating": 3.9, "count": 5, "url": "u", "link": "https://goo.gl/maps/x", "checkedAt": "2026-11-12T00:00:00Z"}}
        out = ratings.update(DATA, old, "KEY", s, timedelta(days=7), NOW, delay=0)
        self.assertEqual(out, old)
        self.assertEqual(s.posts, [])
        out = ratings.update(DATA, old, "KEY", s, timedelta(days=1), NOW, delay=0)
        self.assertEqual(out["20"]["rating"], 4.1)


if __name__ == "__main__":
    unittest.main()
