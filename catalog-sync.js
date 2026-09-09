// Runs on a schedule (Render Cron Job, every 12 hours) to build/refresh a
// searchable battery catalog in Supabase, separate from the live plate-
// lookup flow (which is untouched by this file and keeps scraping fresh on
// every customer search - see scrape.js / server.js, which still use
// Playwright directly and work fine, since HCB's price-hiding behaviour
// only affects the login-gated Ubercart cart widget on product pages, not
// the public plate-search results page).
//
// REWRITTEN 2026-09-08: the original Playwright-driven version logged in
// fine, walked the catalog fine, and read stock/specs fine - but got a
// permanent "$0.00" decoy price on 100/100 SKUs, every run, no matter how
// long it waited. Confirmed live (screenshot evidence) that a genuine
// Chrome window - even a fresh incognito one - sees the real price
// immediately after the exact same Auth0 login. A stealth-patch attempt
// (masking navigator.webdriver etc.) made no difference either. HCB is
// almost certainly running bot/headless detection specifically around
// trade pricing (competitively sensitive data) that goes beyond what
// simple JS property patches can defeat - this is exactly the class of
// problem ScrapingBee's stealth proxy exists for (real browsers behind
// rotating/residential proxies, not a bare headless Chromium), and this
// project already uses ScrapingBee elsewhere (tyrestorescraper, TradeMe
// JS rendering) with the same session_id + render_js=true pattern used
// below.
//
// What this does, end to end:
//   1. Logs in to hcb.co.nz via ScrapingBee, using one persistent
//      session_id for the entire run so login cookies carry across every
//      subsequent request (same pattern already used for TradeMe).
//   2. Walks every page of the "Passenger & Light Commercial" category
//      listing and collects every product card's SKU + category label,
//      filtering out non-starting-battery products and Ultra-branded SKUs
//      (same rules as before).
//   3. Visits each surviving SKU's own product page (same ScrapingBee
//      session, still logged in) and reads price + stock + specs together.
//   4. Computes the same GST-inclusive and 10%-off click-and-collect price
//      already used on the live site (find-battery.js).
//   5. Upserts one row per SKU into Supabase's `battery_catalog` table.
//
// Cost note: this hits ~160 category-listing requests + ~100 product-page
// requests every 12 hours (~520/day). Stealth-proxy + JS-rendering
// requests cost meaningfully more ScrapingBee credits than plain fetches -
// worth checking your plan's quota against this volume.

const cheerio = require("cheerio");
const { isExcludedUltraSku } = require("./scrape");

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || "";
const HCB_USERNAME = process.env.HCB_USERNAME || "";
const HCB_PASSWORD = process.env.HCB_PASSWORD || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const CATEGORY_PATH = "passenger-light-commercial";
const GST_RATE = 1.15;
const CLICK_COLLECT_MULTIPLIER = 0.9;

const STARTING_BATTERY_CATEGORY_RE = /starting battery|start[\s/-]*stop/i;
const EXCLUDED_CATEGORY_RE = /deep cycle/i;

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(args));
}

const SESSION_ID = String(Math.floor(Math.random() * 1000000000));

async function scrapingBeeGet(url, opts) {
  opts = opts || {};
  if (!SCRAPINGBEE_API_KEY) {
    throw new Error("SCRAPINGBEE_API_KEY env var is not set - cannot scrape");
  }

  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url: url,
    render_js: "true",
    session_id: SESSION_ID,
    stealth_proxy: "true",
    country_code: "nz", // Every confirmed working case tonight (Rob's incognito test, interactive testing) was from a genuine NZ connection - testing whether this is geo-fencing rather than (or in addition to) bot detection.
  });
  if (opts.waitFor) params.set("wait_for", opts.waitFor);
  if (opts.extraWaitMs) params.set("wait", String(opts.extraWaitMs));
  if (opts.jsScenario) params.set("js_scenario", JSON.stringify(opts.jsScenario));

  const res = await fetch("https://app.scrapingbee.com/api/v1/?" + params.toString());
  const html = await res.text();
  if (!res.ok) {
    throw new Error("ScrapingBee request failed (" + res.status + "): " + html.slice(0, 300));
  }
  return html;
}

async function loginToHcb() {
  if (!HCB_USERNAME || !HCB_PASSWORD) {
    throw new Error("HCB_USERNAME / HCB_PASSWORD env vars are not set - cannot log in");
  }

  // Single request/session, whole flow: load the homepage, click the real
  // "Log In" link in-page (not a detached second request to its href -
  // confirmed live that Auth0 rejects that as an invalid/expired OAuth
  // state, silently bouncing back to the homepage rather than showing the
  // login form at all), wait for the Auth0 redirect to land, fill and
  // submit, wait for the final redirect back to hcb.co.nz to settle.
  const afterLoginHtml = await scrapingBeeGet("https://hcb.co.nz/", {
    jsScenario: {
      instructions: [
        {
          evaluate:
            "Array.from(document.querySelectorAll('a')).find(a => /log ?in/i.test(a.textContent))?.click();",
        },
        { wait_for: 'input[name="email"]' },
        { fill: ['input[name="email"]', HCB_USERNAME] },
        { fill: ['input[name="password"]', HCB_PASSWORD] },
        { click: 'button[type="submit"]' },
        { wait: 6000 },
      ],
    },
  });

  if (!/logout|log out/i.test(afterLoginHtml)) {
    const $after = cheerio.load(afterLoginHtml);
    log(
      "LOGIN_FORM_NOT_CONFIRMED - actual page state:",
      JSON.stringify({
        title: $after("title").text().trim(),
        bodyLength: afterLoginHtml.length,
        hasEmailInput: $after('input[name="email"]').length > 0,
        hasPasswordInput: $after('input[name="password"]').length > 0,
        firstButtons: $after("button").slice(0, 5).map((_, el) => $after(el).text().trim()).get(),
        bodySnippet: $after("body").text().trim().replace(/\s+/g, " ").slice(0, 400),
      })
    );
    throw new Error("LOGIN_FAILED - 'Logout' not found in page after submitting credentials");
  }
  log("Logged in to hcb.co.nz as", HCB_USERNAME, "(session " + SESSION_ID + ")");
}

async function walkCategoryListing() {
  const items = [];
  let pageNum = 0;
  const MAX_PAGES = 60;

  while (pageNum < MAX_PAGES) {
    const url = "https://hcb.co.nz/" + CATEGORY_PATH + "?page=" + pageNum;
    const html = await scrapingBeeGet(url, { waitFor: ".views-row" }).catch(function () {
      return "";
    });
    const $ = cheerio.load(html);
    const rows = $(".views-row");

    if (rows.length === 0) {
      log("Page " + pageNum + " had no rows - stopping pagination.");
      break;
    }

    rows.each(function (_, row) {
      const $row = $(row);
      const productPath = $row.find("[about]").first().attr("about") || null;
      const sku = $row.find(".field-name-popup-product-link a").first().text().trim() || null;
      const category = $row.find(".field-name-body .field-item").first().text().trim() || null;
      items.push({ productPath: productPath, sku: sku, category: category });
    });

    log("Page " + pageNum + ": " + rows.length + " rows");
    pageNum++;
  }

  return items;
}

async function scrapeCatalogProduct(sku, productPath) {
  const url = productPath ? "https://hcb.co.nz" + productPath : null;
  if (!url) return { sku: sku, found: false };

  // Same bug class as the original Playwright version: .uc-price exists
  // in the DOM almost immediately but often still shows a "0.00"
  // placeholder for several seconds before the real trade price loads
  // via AJAX. A flat wait isn't reliable - poll in-page for an actual
  // non-zero value (up to 10s) instead.
  const html = await scrapingBeeGet(url, {
    jsScenario: {
      instructions: [
        { wait_for: ".uc-price" },
        {
          evaluate:
            "await new Promise((resolve) => { " +
            "const start = Date.now(); " +
            "const check = () => { " +
            "const el = document.querySelector('.uc-price'); " +
            "const m = el && el.textContent.match(/([\\d,]+\\.\\d{2})/); " +
            "const val = m ? parseFloat(m[1].replace(/,/g, '')) : 0; " +
            "if (val > 0 || Date.now() - start > 10000) { resolve(); return; } " +
            "setTimeout(check, 300); " +
            "}; check(); " +
            "});",
        },
      ],
    },
  }).catch(function () {
    return "";
  });
  if (!html) return { sku: sku, found: false };

  const $ = cheerio.load(html);

  function fieldText(cls) {
    const el = $(".field-name-field-" + cls + " .field-item, .field-name-field-" + cls + " .field-items").first();
    const t = el.text().trim();
    return t || null;
  }
  function numFromField(cls) {
    const t = fieldText(cls);
    if (!t) return null;
    const m = t.match(/[\d.]+/);
    return m ? parseFloat(m[0]) : null;
  }

  const category = $(".field-name-body .field-item").first().text().trim() || null;
  const priceText = $(".uc-price").first().text().trim();
  const priceMatch = priceText.match(/([\d,]+\.\d{2})/);
  const priceExGst = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;

  let branchStock = null;
  let nationalStock = null;
  $('[class*="stock-"], [class*="national-"]').each(function (_, el) {
    const cls = $(el).attr("class") || "";
    if (/stock-(green|red)/.test(cls) && branchStock == null) branchStock = /green/.test(cls);
    if (/national-(green|red)/.test(cls) && nationalStock == null) nationalStock = /green/.test(cls);
  });

  const imageUrl = $(".group-img img, .field-name-popup-product-image-field img").first().attr("src") || null;

  const found = priceExGst != null && priceExGst > 0;

  return {
    sku: sku,
    found: found,
    category: category,
    priceExGst: priceExGst,
    branchStock: branchStock,
    nationalStock: nationalStock,
    imageUrl: imageUrl,
    technology: fieldText("lithium"),
    voltage: fieldText("voltage"),
    cca: numFromField("cca"),
  };
}

function computePricing(priceExGst) {
  if (priceExGst == null) return { priceExGst: null, priceInclGst: null, clickCollectPrice: null };
  const priceInclGst = Math.round(priceExGst * GST_RATE * 100) / 100;
  const clickCollectPrice = Math.round(priceInclGst * CLICK_COLLECT_MULTIPLIER * 100) / 100;
  return { priceExGst: priceExGst, priceInclGst: priceInclGst, clickCollectPrice: clickCollectPrice };
}

async function upsertCatalogRows(rows) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set - cannot upsert");
  }
  if (rows.length === 0) return;

  const res = await fetch(SUPABASE_URL + "/rest/v1/battery_catalog?on_conflict=sku", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const detail = await res.text().catch(function () {
      return "";
    });
    throw new Error("Supabase upsert failed: " + res.status + " " + detail);
  }
}

async function run() {
  const startedAt = Date.now();
  let upserted = 0;
  let skippedNonStarting = 0;
  let skippedUltra = 0;
  let failed = 0;

  await loginToHcb();

  log("Walking category listing:", CATEGORY_PATH);
  const listing = await walkCategoryListing();
  log("Category walk complete: " + listing.length + " total cards found.");

  const candidates = listing.filter(function (item) {
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
    "Filtered to " + candidates.length + " starting-battery SKUs " +
      "(skipped " + skippedUltra + " Ultra-branded, " + skippedNonStarting + " non-starting-battery)."
  );

  const batch = [];
  const BATCH_SIZE = 20;

  for (const item of candidates) {
    try {
      const product = await scrapeCatalogProduct(item.sku, item.productPath);
      if (!product.found) {
        log("No price found for " + item.sku + " - skipping (likely still bot-blocked, discontinued, or hidden).");
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
        log("Upserted " + upserted + "/" + candidates.length + "...");
      }
    } catch (err) {
      log("ERROR scraping " + item.sku + ":", err.message || err);
      failed++;
    }
  }

  if (batch.length > 0) {
    await upsertCatalogRows(batch);
    upserted += batch.length;
  }

  const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
  log(
    "DONE. " + upserted + " SKUs upserted, " + failed + " failed, " +
      (skippedUltra + skippedNonStarting) + " skipped. Took " + minutes + " min."
  );
}

// One-off diagnostic: takes an actual screenshot of a single product
// page (via ScrapingBee's screenshot mode, same session/login/stealth
// settings as the real scrape) and uploads it to Supabase Storage so it
// can be viewed directly - text-based diagnosis has been exhausted
// (login confirmed working, category/stock/specs all extract fine,
// price consistently fails across every approach tried), so seeing the
// actual rendered page is the next real diagnostic step.
async function diagnosticScreenshot(sku) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set");
  }

  await loginToHcb();

  const listing = await walkCategoryListing();
  const item = listing.find(function (i) {
    return i.sku === sku;
  });
  if (!item || !item.productPath) {
    throw new Error("DIAGNOSTIC_SKU '" + sku + "' not found in category listing");
  }
  log("Found", sku, "at", item.productPath, "- taking screenshot...");

  const url = "https://hcb.co.nz" + item.productPath;
  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url: url,
    render_js: "true",
    session_id: SESSION_ID,
    stealth_proxy: "true",
    country_code: "nz",
    screenshot: "true",
    // Viewport-only, not full-page - a full-page screenshot is tall enough
    // that Supabase's dashboard thumbnail squishes the top section (where
    // the price/cart panel lives) into an unreadable sliver.
    wait: "5000",
  });

  const res = await fetch("https://app.scrapingbee.com/api/v1/?" + params.toString());
  if (!res.ok) {
    const detail = await res.text().catch(function () {
      return "";
    });
    throw new Error("ScrapingBee screenshot request failed (" + res.status + "): " + detail.slice(0, 300));
  }
  const imageBuffer = Buffer.from(await res.arrayBuffer());
  log("Screenshot captured:", imageBuffer.length, "bytes");

  const bucketName = "diagnostics";
  await fetch(SUPABASE_URL + "/storage/v1/bucket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ id: bucketName, name: bucketName, public: true }),
  }); // ignore result - fine if it already exists

  const path = "price-diagnostic-" + sku.replace(/[^a-zA-Z0-9]/g, "_") + "-" + Date.now() + ".png";
  const uploadRes = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucketName + "/" + path, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
    },
    body: imageBuffer,
  });

  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(function () {
      return "";
    });
    throw new Error("Supabase Storage upload failed: " + uploadRes.status + " " + detail);
  }

  const publicUrl = SUPABASE_URL + "/storage/v1/object/public/" + bucketName + "/" + path;
  log("DIAGNOSTIC_SCREENSHOT_URL:", publicUrl);
}

if (require.main === module) {
  if (process.env.DIAGNOSTIC_SKU) {
    diagnosticScreenshot(process.env.DIAGNOSTIC_SKU).catch(function (err) {
      console.error("DIAGNOSTIC_FAILED", err);
      process.exit(1);
    });
  } else {
    run().catch(function (err) {
      console.error("CATALOG_SYNC_FAILED", err);
      process.exit(1);
    });
  }
}

module.exports = { run: run };
