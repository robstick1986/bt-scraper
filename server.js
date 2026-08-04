// Small HTTP API wrapping the battery-town scraper.
//
// GET /scrape-plate?plate=ABC123[&vehicleIndex=0]
// GET /scrape-product?sku=N70ZL/17
// Header: x-api-key: <API_KEY>
//
// Response: { plate, found, vehicle, stopStartWarning, products } — or, when
// a plate matches more than one vehicle and vehicleIndex wasn't supplied:
// { plate, found: false, disambiguation: true, vehicleOptions: [...] }.
// / { sku, found, ...specs }

const http = require("http");
const { URL } = require("url");
const { scrapePlate, scrapeProduct } = require("./scrape");

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.API_KEY || "";

// Very simple concurrency guard — headless Chrome is heavy; don't let this
// box fall over if several lookups land at once. Extra requests queue.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);
let inFlight = 0;
const queue = [];

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      inFlight++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          inFlight--;
          if (queue.length) queue.shift()();
        });
    };
    if (inFlight < MAX_CONCURRENT) task();
    else queue.push(task);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }

  if (url.pathname !== "/scrape-plate" && url.pathname !== "/scrape-product") {
    return send(res, 404, { error: "not found" });
  }

  if (API_KEY) {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) {
      return send(res, 401, { error: "unauthorized" });
    }
  }

  if (url.pathname === "/scrape-plate") {
    const plate = (url.searchParams.get("plate") || "").trim();
    if (!plate) {
      return send(res, 400, { error: "missing required query parameter: plate" });
    }
    if (!/^[A-Za-z0-9]{1,8}$/.test(plate)) {
      return send(res, 400, { error: "plate looks invalid" });
    }

    // Optional: which vehicle to pick when a plate matches more than one
    // (HCB's disambiguation list). Omitted on the first request; the
    // frontend re-calls with this set once the customer/staff picks.
    const vehicleIndexRaw = url.searchParams.get("vehicleIndex");
    const vehicleIndex =
      vehicleIndexRaw != null && vehicleIndexRaw !== "" ? parseInt(vehicleIndexRaw, 10) : null;

    try {
      const result = await runQueued(() => scrapePlate(plate, { vehicleIndex }));
      return send(res, 200, result);
    } catch (err) {
      console.error("scrape failed for", plate, err);
      return send(res, 502, { error: "scrape failed", detail: String(err.message || err) });
    }
  }

  // /scrape-product
  const sku = (url.searchParams.get("sku") || "").trim();
  if (!sku) {
    return send(res, 400, { error: "missing required query parameter: sku" });
  }
  if (!/^[A-Za-z0-9/\-. ]{1,20}$/.test(sku)) {
    return send(res, 400, { error: "sku looks invalid" });
  }

  try {
    const result = await runQueued(() => scrapeProduct(sku));
    return send(res, 200, result);
  } catch (err) {
    console.error("product scrape failed for", sku, err);
    return send(res, 502, { error: "scrape failed", detail: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`battery-town scraper listening on :${PORT}`);
  if (!API_KEY) {
    console.warn("WARNING: API_KEY is not set — this endpoint is unauthenticated.");
  }
});
