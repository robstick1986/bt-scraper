// Runs on a schedule (Render Cron Job, every 12 hours) to build/refresh a
// searchable battery catalog in Supabase, separate from the live plate-
// lookup flow (which is untouched by this file and keeps scraping fresh on
// every customer search â see scrape.js / server.js).
//
// What this does, end to end:
//   1. Logs in to hcb.co.nz (standard Drupal login form: name/pass fields)
//      so product pages reveal price ("uc-price", RRP excl GST) and stock
//      (Branch/National green-or-red indicators) â both are hidden from
//      logged-out visitors (confirmed live: logged-out product pages show
//      specs only, no price, no stock at all).
//   2. Walks every page of the "Passenger & Light Commercial" category
//      listing (https://hcb.co.nz/passenger-light-commercial?page=N) and
//      collects every product card's SKU + category label. Confirmed this
//      category mixes in non-starting-battery products (flooded deep cycle
//      batteries, e.g. "12B"/"12BU"), so the category label per card is
//      used to filter down to starting batteries only.
//   3. Drops any "Ultra"-branded SKU (trailing "U", e.g. "DIN66U") â Mags &
//      Tyres doesn't stock that line (same rule as scrape.js).
//   4. Visits each surviving SKU's own product page (logged in) and reads
//      price + stock + specs together in one page load.
//   5. Computes the same GST-inclusive and 10%-off click-and-collect price
//      already used on the live site (find-battery.js), so search results
//      are priced identically to the plate-lookup flow.
//   6. Upserts one row per SKU into Supabase's `battery_catalog` table
//      (on_conflict=sku), so a customer-facing "search by name" endpoint
//      can query Supabase directly instead of live-scraping HCB per search.
//
// This file does NOT touch `battery_specs` (the existing spec cache) or the
// live plate-lookup path â both keep working exactly as they do today.
// Drift-detection note (per Rob's decision, 2026-08 build session): a
// dedicated age-based re-scrape of battery_specs was explicitly skipped in
// favour of this job double-checking category label text against what's
// already cached, and flagging (not auto-overwriting) anything that looks
// to have changed â see checkSpecDrift() below.

const { chromium } = require("playwright-core");
const { isExcludedUltraSku } = require("./scrape");

const CHROMIUM_PATH =
process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const HCB_USERNAME = process.env.HCB_USERNAME || "";
const HCB_PASSWORD = process.env.HCB_PASSWORD || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const CATEGORY_PATH = "passenger-light-commercial";
const GST_RATE = 1.15; // 15% NZ GST â same constant as find-battery.js
const CLICK_COLLECT_MULTIPLIER = 0.9; // "10% off for Online Purchase" â same as the live site

// Only these category labels (as shown on HCB's own listing/product pages)
// count as a car starting battery for this catalog. Everything else on the
// Passenger & Light Commercial listing (flooded deep cycle, etc.) is
// skipped. Matched case-insensitively; HCB's own casing is inconsistent
// (e.g. "AUTOMOTIVE STARTING BATTERY" vs "Automotive Starting Battery").
const STARTING_BATTERY_CATEGORY_RE = /starting battery|start[\s/-]*stop/i;
const EXCLUDED_CATEGORY_RE = /deep cycle/i;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function loginToHcb(page) {
  if (!HCB_USERNAME || !HCB_PASSWORD) {
    throw new Error("HCB_USERNAME / HCB_PASSWORD env vars are not set â cannot log in");
  }

await page.goto("https://hcb.co.nz/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
});
    await page.waitForTimeout(2500);

    // Land on the login page via the "Log In" link in the header nav, like a
        // real visitor, rather than requesting /user/login directly - a direct
    // request came back with an empty title and zero <input> elements at
    // all (confirmed live), which looks like a bot-protection block on that
    // specific URL rather than a wrong CSS selector.
    const loginLink = page.locator('a:has-text("Log In"), a:has-text("LOG IN")').first();
    await loginLink.click();
    await page.waitForTimeout(2500);

    // This is an Auth0-hosted Universal Login page (hcb-technologies.auth0.com),
    // not a native Drupal form (confirmed live via the diagnostic dump
    // below). Real field names are "email" and "password".
    const nameInput = page.locator('input[name="email"]');
    const passInput = page.locator('input[name="password"]');
    try {
          await nameInput.waitFor({ state: "visible", timeout: 20000 });
    } catch (err) {
          const pageInfo = await page.evaluate(() => ({
                  url: location.href,
                  title: document.title,
                  inputs: Array.from(document.querySelectorAll("input")).map((el) => ({
                            name: el.name || null,
                            id: el.id || null,
                            type: el.type || null,
                            placeholder: el.placeholder || null,
                  })),
          }));
          log("LOGIN_FORM_NOT_FOUND", JSON.stringify(pageInfo, null, 2));
          throw err;
    }
    await nameInput.fill(HCB_USERNAME);
    await passInput.fill(HCB_PASSWORD);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
          page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);

  const bodyText = await page.evaluate(() => document.body.innerText);
  if (!/logout|log out/i.test(bodyText)) {
    throw new Error("Login did not succeed â 'Logout' link not found after submitting credentials");
  }
  log("Logged in to hcb.co.nz as", HCB_USERNAME);
}

// Walks every page of the category listing and returns [{ sku, productPath, category }]
async function walkCategoryListing(page) {
  const items = [];
  let pageNum = 0;
  // Generous upper bound as a safety net against an infinite loop if HCB's
  // pagination markup ever changes shape; 20 pages was the real count when
  // this was built (confirmed live), so 60 gives lots of headroom.
  const MAX_PAGES = 60;

  while (pageNum < MAX_PAGES) {
    const url = `https://hcb.co.nz/${CATEGORY_PATH}?page=${pageNum}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(500);

    const rows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".views-row"));
      return rows.map((row) => {
        const node = row.querySelector("[about]");
        const skuLink = row.querySelector(".field-name-popup-product-link a");
        const categoryEl = row.querySelector(".field-name-body .field-item");
        return {
          productPath: node ? node.getAttribute("about") : null,
          sku: skuLink ? skuLink.textContent.trim() : null,
          category: categoryEl ? categoryEl.textContent.trim() : null,
        };
      });
    });

    if (rows.length === 0) {
      log(`Page ${pageNum} had no rows â stopping pagination.`);
      break;
    }

    items.push(...rows);
    log(`Page ${pageNum}: ${rows.length} rows`);
    pageNum++;
  }

  return items;
}

// Visits one product page (must already be logged in) and returns price,
// stock, and specs together.
async function scrapeCatalogProduct(page, sku, productPath) {
  const url = productPath ? `https://hcb.co.nz${productPath}` : null;
  if (!url) return { sku, found: false };

  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!res || res.status() === 404) {
    return { sku, found: false };
  }

  // Price/stock render a beat after the page loads (confirmed live: not
  // present in the initial DOM, appears ~2-3s later via AJAX).
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
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
    const priceEl = document.querySelector(".uc-price");
    const priceText = priceEl ? priceEl.textContent.trim() : "";
    const priceMatch = priceText.match(/([\d,]+\.\d{2})/);

    const stockSpans = Array.from(document.querySelectorAll('[class*="stock-"], [class*="national-"]'));
    const branchStockEl = stockSpans.find((el) => /stock-(green|red)/.test(el.className));
    const nationalStockEl = stockSpans.find((el) => /national-(green|red)/.test(el.className));

    const imgEl = document.querySelector(".group-img img, .field-name-popup-product-image-field img");

    return {
      category: categoryEl ? categoryEl.textContent.trim() || null : null,
      priceExGst: priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null,
      branchStock: branchStockEl ? /green/.test(branchStockEl.className) : null,
      nationalStock: nationalStockEl ? /green/.test(nationalStockEl.className) : null,
      imageUrl: imgEl && imgEl.src ? imgEl.src : null,
      technology: fieldText("lithium"),
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

  return { sku, found: data.priceExGst != null, ...data };
}

// Pricing math kept identical to find-battery.js so search results and
// plate-lookup results never disagree on price for the same SKU.
function computePricing(priceExGst) {
  if (priceExGst == null) return { priceExGst: null, priceInclGst: null, clickCollectPrice: null };
  const priceInclGst = Math.round(priceExGst * GST_RATE * 100) / 100;
  const clickCollectPrice = Math.round(priceInclGst * CLICK_COLLECT_MULTIPLIER * 100) / 100;
  return { priceExGst, priceInclGst, clickCollectPrice };
}

async function upsertCatalogRows(rows) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set â cannot upsert");
  }
  if (rows.length === 0) return;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/battery_catalog?on_conflict=sku`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase upsert failed: ${res.status} ${detail}`);
  }
}

async function run() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const startedAt = Date.now();
  let upserted = 0;
  let skippedNonStarting = 0;
  let skippedUltra = 0;
  let failed = 0;

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    await loginToHcb(page);

    log("Walking category listing:", CATEGORY_PATH);
    const listing = await walkCategoryListing(page);
    log(`Category walk complete: ${listing.length} total cards found.`);

    const candidates = listing.filter((item) => {
      if (!item.sku || !item.productPath) return false;
      if (isExcludedUltraSku(item.sku)) {
        skippedUltra++;
        return false;
      }
      const category = item.category || "";
      if (EXCLUDED_CATEGORY_RE.test(category) || !STARTING_BATTERY_CATEGORY_RE.test(category)) {
        skippedNonStarting++;
        return false;
      }
      return true;
    });
    log(
      `Filtered to ${candidates.length} starting-battery SKUs ` +
        `(skipped ${skippedUltra} Ultra-branded, ${skippedNonStarting} non-starting-battery).`
    );

    const batch = [];
    const BATCH_SIZE = 20; // upsert in chunks so one Supabase call failing doesn't lose everything

    for (const item of candidates) {
      try {
        const product = await scrapeCatalogProduct(page, item.sku, item.productPath);
        if (!product.found) {
          log(`No price found for ${item.sku} â skipping (likely discontinued or hidden SKU).`);
          failed++;
          continue;
        }

        const pricing = computePricing(product.priceExGst);

        batch.push({
          sku: item.sku.toUpperCase(),
          name: item.sku,
          category: product.category || item.category,
          price_ex_gst: pricing.priceExGst,
          price_incl_gst: pricing.priceInclGst,
          click_collect_price: pricing.clickCollectPrice,
          branch_stock: product.branchStock,
          national_stock: product.nationalStock,
          image_url: product.imageUrl,
          technology: product.technology,
          voltage: product.voltage,
          cca: product.cca,
          scraped_at: new Date().toISOString(),
        });

        if (batch.length >= BATCH_SIZE) {
          await upsertCatalogRows(batch.splice(0, batch.length));
          upserted += BATCH_SIZE;
          log(`Upserted ${upserted}/${candidates.length}...`);
        }
      } catch (err) {
        log(`ERROR scraping ${item.sku}:`, err.message || err);
        failed++;
      }
    }

    if (batch.length > 0) {
      await upsertCatalogRows(batch);
      upserted += batch.length;
    }

    const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
    log(
      `DONE. ${upserted} SKUs upserted, ${failed} failed, ` +
        `${skippedUltra + skippedNonStarting} skipped. Took ${minutes} min.`
    );
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error("CATALOG_SYNC_FAILED", err);
    process.exit(1);
  });
}

module.exports = { run };
