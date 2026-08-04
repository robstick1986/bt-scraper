// Drives a real headless browser through HCB Technologies' own number-plate
// search (hcb.co.nz) and extracts the vehicle info + HCB's own recommended
// battery(ies) for that vehicle, including live retail pricing and stock.
//
// hcb.co.nz was chosen over batterytown.co.nz (an earlier version of this
// scraper's target) because it shows live RRP pricing directly on the
// results page without needing a trade login, so this one scrape can drive
// both "what battery" and "what it costs" — no separate pricing catalog
// needed.
//
// WHY A REAL BROWSER: hcb.co.nz's internal AJAX endpoint sits behind the
// same Imperva/Incapsula bot protection as batterytown.co.nz (both are
// built on the same "vs-" vehicle-search widget) plus a device-fingerprint
// cookie, and rejects requests that don't come from a genuine browser
// session. Driving an actual headless browser respects that (real page
// load, real JS execution, real cookies) instead of trying to replay/spoof
// the API call directly.

const { chromium } = require("playwright-core");

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function scrapePlate(plate, { headless = true } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    await page.goto("https://hcb.co.nz/number-plate-search", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Give the React bundle + Incapsula's JS challenge a moment to settle
    // before the form is interactive.
    await page.waitForTimeout(2500);

    const input = page.locator('input[placeholder="Enter Plate Number"]');
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click();
    await input.fill(plate);

    const searchBtn = page.getByRole("button", { name: "Search", exact: true }).first();
    await searchBtn.click();

    // Wait for either a result banner or a "not found" message to appear.
    await page
      .waitForFunction(
        () => {
          const body = document.body.innerText || "";
          return /Make:|not found|No results|invalid/i.test(body);
        },
        { timeout: 20000 }
      )
      .catch(() => {});

    // The vehicle summary banner (with "Make:") renders first; the battery
    // results table (`.vs-results-row`) is populated a beat later by a
    // separate call. A fixed short sleep here was intermittently winning
    // the race and reading the DOM before any rows existed (returning a
    // correct vehicle but an empty `products` array) — especially under
    // Render's environment, which is slower/further from hcb.co.nz than a
    // regular browser. Wait specifically for a result row (or give up after
    // a generous timeout) instead of guessing a fixed delay.
    await page
      .waitForSelector(".vs-results-row", { timeout: 12000 })
      .catch(() => {});

    const bodyText = await page.evaluate(() => document.body.innerText);

    if (/not found|no results/i.test(bodyText) && !/Make:/i.test(bodyText)) {
      return { plate: plate.toUpperCase(), found: false, vehicle: null, products: [] };
    }

    // Vehicle details and results use the site's own CSS classes (confirmed
    // live on hcb.co.nz, which shares its "vs-" vehicle-search widget with
    // batterytown.co.nz): the vehicle summary lives in
    // `.vs-selected-vehicle-name` with one `<span class="make|model|year|
    // series-chassis|engine">` per field (each holding a label + a value
    // span). Each recommended battery is a `.vs-results-row` containing
    // `.vs-results-partnum` (SKU), `.vs-results-note` (stop/start line),
    // `.vs-price-rrp` (live RRP, ex GST), `.vs-results-stock` (stock status
    // spans), and a product image. (batterytown.co.nz additionally exposes
    // `.vs-results-cca` / `.vs-results-technology`, which hcb.co.nz's page
    // doesn't show — extracted opportunistically below in case that ever
    // changes; they'll just be null here.)
    const { vehicle, products } = await page.evaluate(() => {
      function fieldValue(root, cls) {
        const el = root ? root.querySelector(`span.${cls}`) : null;
        if (!el) return null;
        // Last element child is the value span; falls back to full text.
        const valueEl = el.children[el.children.length - 1];
        const text = (valueEl ? valueEl.textContent : el.textContent) || "";
        return text.trim() || null;
      }

      const vehicleRoot = document.querySelector(".vs-selected-vehicle-name");
      const vehicle = vehicleRoot
        ? {
            make: fieldValue(vehicleRoot, "make"),
            model: fieldValue(vehicleRoot, "model"),
            year: fieldValue(vehicleRoot, "year"),
            seriesChassis: fieldValue(vehicleRoot, "series-chassis"),
            engine: fieldValue(vehicleRoot, "engine"),
          }
        : null;

      const rows = Array.from(document.querySelectorAll(".vs-results-row"));
      const products = rows.map((row) => {
        const sku = row.querySelector(".vs-results-partnum");
        const note = row.querySelector(".vs-results-note");
        const cca = row.querySelector(".vs-results-cca");
        const tech = row.querySelector(".vs-results-technology");
        const rrp = row.querySelector(".vs-price-rrp");
        const img = row.querySelector(".vs-results-pic img");
        const stockEls = Array.from(row.querySelectorAll(".vs-results-stock span"));

        const ccaText = cca ? cca.textContent.replace(/^.*?CCA/i, "") : "";
        const ccaNum = ccaText.match(/(\d+)/);
        const techText = tech ? tech.textContent.replace(/^.*?Technology/i, "") : "";
        const noteText = note ? note.textContent.trim() : "";

        // rrp textContent looks like "RRP:$273.66(excl GST)".
        const rrpText = rrp ? rrp.textContent : "";
        const rrpMatch = rrpText.match(/([\d,]+\.\d{2})/);

        return {
          sku: sku ? sku.textContent.trim() : null,
          note: noteText || null,
          stopStart: noteText ? /^With\b/i.test(noteText) : null,
          cca: ccaNum ? parseInt(ccaNum[1], 10) : null,
          technology: techText.replace(/^[:\s]+/, "").trim() || null,
          priceExGst: rrpMatch ? parseFloat(rrpMatch[1].replace(/,/g, "")) : null,
          stock: stockEls.map((s) => s.textContent.trim()).filter(Boolean),
          imageUrl: img && img.src ? img.src : null,
          rawText: row.innerText.trim(),
        };
      });

      return { vehicle, products };
    });

    return {
      plate: plate.toUpperCase(),
      found: !!(vehicle && vehicle.make) || products.length > 0,
      vehicle: vehicle && vehicle.make ? vehicle : null,
      products,
    };
  } finally {
    await browser.close();
  }
}

// Fetches full physical specs for a single battery SKU from its own HCB
// product page (e.g. https://hcb.co.nz/products/n70zl17 for "N70ZL/17").
// Unlike price/stock (which change and get scraped fresh on every plate
// lookup), these specs — dimensions, CCA, weight, terminal layout — are
// static per SKU, so callers are expected to cache this result (see the
// battery-spec Netlify function, which caches into Supabase and only calls
// this endpoint once per SKU ever).
//
// HCB's product pages are plain Drupal "field" markup — each spec lives in
// a `.field-name-field-<name>` block with a `.field-item` holding the
// value (confirmed live by inspecting hcb.co.nz/products/n70zl17). No bot
// challenge was observed on these pages, but we still drive a real browser
// for consistency with the rest of this scraper.
async function scrapeProduct(sku, { headless = true } = {}) {
  const slug = String(sku).toLowerCase().replace(/[^a-z0-9]/g, "");
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    const res = await page.goto(`https://hcb.co.nz/products/${slug}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (!res || res.status() === 404) {
      return { sku: String(sku).toUpperCase(), found: false };
    }

    await page.waitForTimeout(1500);

    const specs = await page.evaluate(() => {
      function fieldText(cls) {
        const el = document.querySelector(
          `.field-name-field-${cls} .field-item, .field-name-field-${cls} .field-items`
        );
        return el ? el.textContent.trim() || null : null;
      }
      function numFromField(cls) {
        const t = fieldText(cls);
        if (!t) return null;
        const m = t.match(/[\d.]+/);
        return m ? parseFloat(m[0]) : null;
      }
      const categoryEl = document.querySelector(".field-name-body .field-item");

      return {
        category: categoryEl ? categoryEl.textContent.trim() || null : null,
        technology: fieldText("lithium"), // HCB's own (oddly-named) field class for battery technology
        voltage: fieldText("voltage"),
        cca: numFromField("cca"),
        lengthMm: numFromField("length"),
        widthMm: numFromField("width"),
        boxHeightMm: numFromField("height"),
        weightKg: numFromField("weight"),
        holddown: fieldText("holddown"),
        terminalType: fieldText("terminal-tp"),
        assembly: fieldText("assy"),
      };
    });

    const found = Object.values(specs).some((v) => v != null);

    return { sku: String(sku).toUpperCase(), found, ...specs };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapePlate, scrapeProduct };

// Allow running directly for local testing: node scrape.js MAGURU
if (require.main === module) {
  const plate = process.argv[2] || "MAGURU";
  scrapePlate(plate)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error("SCRAPE_ERROR", err);
      process.exit(1);
    });
}
