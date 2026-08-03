# Battery Town plate-search scraper

A small always-on service that looks up a NZ number plate on
batterytown.co.nz's public number-plate search and returns the vehicle
details plus Battery Town's own recommended battery(ies) for that vehicle
(SKU, CCA, technology, whether it's a stop/start fitment).

## Why this exists

batterytown.co.nz's internal API is behind Imperva/Incapsula bot protection
and a device-fingerprint cookie, so it can't be called directly from a
lightweight serverless function — it needs to look like a real browser
session. This service drives an actual headless Chrome browser through the
real page (types the plate, clicks Search, reads the result), which is a
legitimate way to read the same information a customer would see, and is
not affected by the bot protection.

It needs to run somewhere with a normal internet connection, always on —
not on Netlify (no headless-browser support there). Running it in Docker
means it doesn't touch anything else on your server; it's fully
self-contained.

## Running it

You need Docker installed. Then, from this folder:

```bash
docker build -t bt-scraper .
docker run -d \
  --name bt-scraper \
  --restart unless-stopped \
  -p 8787:8787 \
  -e API_KEY="choose-a-long-random-secret-here" \
  bt-scraper
```

Check it's up:

```bash
curl http://localhost:8787/health
# {"ok":true}

curl -H "x-api-key: choose-a-long-random-secret-here" \
  "http://localhost:8787/scrape-plate?plate=MAGURU"
```

That last call takes a few seconds (it's genuinely loading the page in a
headless browser) and returns something like:

```json
{
  "plate": "MAGURU",
  "found": true,
  "vehicle": {
    "make": "TOYOTA",
    "model": "LANDCRUISER PRADO",
    "year": "08/2015 ~ 08/2020",
    "seriesChassis": "GDJ150R-GDJ150",
    "engine": "2.8L DIE 1GDFTV I4 16v DOHC I/C Turbo CRD {130kW}"
  },
  "products": [
    {
      "sku": "NS70L",
      "cca": 600,
      "technology": "Flooded Calcium Calcium",
      "stopStart": false,
      "rawText": "..."
    }
  ]
}
```

## Making it reachable from Netlify

The Netlify function needs to reach this service over the internet, which
means your router needs to forward a port to this server (or you use
something like a Cloudflare Tunnel / Tailscale Funnel if you'd rather not
open a port directly). Whichever way you expose it, you'll end up with a
public URL — send that (and the API_KEY you chose above) back and I'll wire
it into the Netlify site as `SCRAPER_SERVICE_URL` and `SCRAPER_API_KEY`.

**Security note:** the `API_KEY` is the only thing stopping a random
internet visitor from using your server to scrape Battery Town on your
behalf and running up your bandwidth/CPU — pick something long and random,
and don't reuse a password you use anywhere else.

## Updating

Battery Town can change their page layout at any time, which would break
the text-parsing logic in `scrape.js`. If lookups start coming back with
`"found": false` for plates you know are valid, that's the first thing to
check — the extraction regex/DOM-walk in `scrape.js` may need updating to
match a layout change.

## Resource use

Each lookup launches a real headless Chrome instance, which is heavier than
a typical API call (roughly 150-300MB RAM and a few seconds per lookup).
The service caps concurrent lookups at 2 at a time by default
(`MAX_CONCURRENT` env var) so a burst of customer searches won't overload
the box; extra requests queue briefly rather than failing.
