# Travelex síút-szűrő

Unofficial filter UI for the ski trips listed on [travelex.si](https://travelex.si).
The original site cannot filter by price or by what is still bookable; this one can.

- **Scraper** (`scraper/scrape.py`): reads the resort list and each resort's accommodation
  price tables (12 plain HTTP requests) and writes JSON into `web/public/data/`.
  - `data.json` – current prices and availability
  - `events.json` – log of price changes, sold-out and re-opened apartments
  - `sellout.json` – history of how many apartment options are sold out per week / resort
- **Web UI** (`web/`): static Vite + React app (Hungarian). Filters by group size, travel
  method (own travel / bus / flight), price per person, weeks, resorts, piste length,
  distance to the slopes and apartment size. For each accommodation and week it computes
  the cheapest apartment combination for the group, including empty-bed fees, and links
  to the travelex.si calculator pre-filled with that selection.
- **Automation** (`.github/workflows/scrape-deploy.yml`): every 6 hours scrapes, commits
  the data when something changed, and deploys to GitHub Pages.

## Hosting on GitHub Pages (project page)

The site is built with a relative base path, so it works at
`https://<user>.github.io/<repo-name>/` without configuration.

1. Merge this into `main` (scheduled workflows only run on the default branch).
2. Repository **Settings → Pages → Source: GitHub Actions**.
3. Run the *Scrape and deploy* workflow once from the Actions tab (or wait for the schedule).

## Running locally

```sh
pip install -r scraper/requirements.txt
python scraper/scrape.py            # refresh web/public/data

cd web
npm install
npm run dev                         # http://localhost:5173
npm test
```

## Pricing model

Each traveller pays the per-person price of their apartment for the chosen travel method;
each unused bed costs that apartment's empty-bed fee (checked against the site's own
calculator). Not included: the per-person handling fee the calculator adds at booking
and any discounts. The site does not publish how many apartments of a type remain, so a
type that is not sold out is assumed to be bookable as often as needed.
