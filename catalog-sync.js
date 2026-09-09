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

// ScrapingBee's session_id only pins the same proxy IP across requests -
// confirmed via their own Python SDK docs ("session_id: Reuse the same
// proxy across requests"). It does NOT persist cookies/login state the
// way a real browser session would. Every scrapingBeeGet() call is a
// fresh browser instance server-side. Diagnosed live 2026-09-09: a
// screenshot taken minutes after a successful login still showed a
// logged-out page ("LOG IN" button visible, no account/logout link) -
// this is why every price attempt failed despite login "succeeding".
// Fix: request json_response=true (ScrapingBee's own blog post on
// building a login bot uses exactly this pattern), which returns cookies
// explicitly in the JSON body, then forward them via the `cookies` param
// on every later request.
let CAPTURED_COOKIES = "";

async function scrapingBeeGet(url, opts) {
  opts = opts || {};
  if (!SCRAPINGBEE_API_KEY) {
    throw new Error("SCRAPINGBEE_API_KEY env var is not set - cannot scrape");
  }

  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url: url,
    render_js: "true",
    session_id: opts.sessionId || SESSION_ID,
    // Switched from stealth_proxy: diagnosed live that every single
    // request was landing on a genuinely different Incapsula node
    // (a different incap_ses_* cookie almost every time), which meant
    // the login cookie captured from one node was never valid on the
    // next - explains why login always "succeeded" but every later
    // request was still logged out regardless of cookie forwarding.
    // Stealth proxies are built for aggressive IP/session rotation
    // (that's the evasion mechanism), which is fundamentally at odds
    // with session_id's "reuse the same proxy" promise. premium_proxy
    // is a lighter tier that should honour that promise more literally.
    stealth_proxy: "true",
    country_code: "nz",
    json_response: "true",
  });
  if (opts.waitFor) params.set("wait_for", opts.waitFor);
  if (opts.extraWaitMs) params.set("wait", String(opts.extraWaitMs));
  if (opts.jsScenario) params.set("js_scenario", JSON.stringify(opts.jsScenario));
  if (CAPTURED_COOKIES) params.set("cookies", CAPTURED_COOKIES);

  const res = await fetch("https://app.scrapingbee.com/api/v1/?" + params.toString());
  const raw = await res.text();
  if (!res.ok) {
    throw new Error("ScrapingBee request failed (" + res.status + "): " + raw.slice(0, 300));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error("ScrapingBee json_response did not return valid JSON: " + raw.slice(0, 300));
  }

  if (data.cookies) {
    // Log the raw value once, unconditionally - a previous run's error
    // ("Could not parse Cookie string, should be name_1=value1;name_2=value2")
    // proved whatever format this actually is wasn't being reformatted
    // correctly. Seeing the real value beats guessing at the shape again.
    log("RAW_COOKIES_FROM_SCRAPINGBEE (" + typeof data.cookies + "):", JSON.stringify(data.cookies).slice(0, 500));

    CAPTURED_COOKIES = normalizeCookies(data.cookies);
  }

  const body = data.body || data.html || "";
  if (!body) {
    // Guessed field names ("body"/"html") were apparently wrong - dump
    // the real top-level shape so this only needs diagnosing once.
    log(
      "JSON_RESPONSE_SHAPE_UNKNOWN - keys:",
      JSON.stringify(Object.keys(data)),
      "cookies field type/length:",
      typeof data.cookies,
      data.cookies ? String(data.cookies).length : 0
    );
  }
  return body;
}

// ScrapingBee requires cookies as exactly "name_1=value1;name_2=value2" -
// no spaces, semicolon-separated. Their own `cookies` response field
// might come back as that same string, as an array of {name, value}
// objects, or as a plain {name: value} map - normalize any of those into
// the one format they'll actually accept, rather than assuming a shape.
function normalizeCookies(raw) {
  let pairs = [];
  if (typeof raw === "string") {
    pairs = raw
      .split(";")
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
  } else if (Array.isArray(raw)) {
    pairs = raw
      .map(function (c) {
        if (c && typeof c === "object" && "name" in c) return c.name + "=" + c.value;
        return null;
      })
      .filter(Boolean);
  } else if (raw && typeof raw === "object") {
    pairs = Object.keys(raw).map(function (k) {
      return k + "=" + raw[k];
    });
  }
  return pairs.join(";");
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
  log("Logged in to hcb.co.nz as", HCB_USERNAME, "- captured cookie length:", CAPTURED_COOKIES.length);
}

async function walkCategoryListing() {
  const items = [];
  let pageNum = 0;
  const MAX_PAGES = 60;

  while (pageNum < MAX_PAGES) {
    const url = "https://hcb.co.nz/" + CATEGORY_PATH + "?page=" + pageNum;
    // No silent catch-to-empty-string here anymore - that was masking a
    // real ScrapingBee error as "0 rows, stop pagination" with zero
    // visibility into why. Let genuine failures surface.
    const html = await scrapingBeeGet(url, { waitFor: ".views-row" });
    const $ = cheerio.load(html);
    const rows = $(".views-row");

    if (rows.length === 0) {
      log(
        "Page " + pageNum + " had no rows - stopping pagination. HTML length:",
        html.length,
        "title:",
        $("title").text().trim(),
        "cookies sent (len):",
        CAPTURED_COOKIES.length
      );
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

  // Cross-request cookie/session persistence never worked reliably -
  // diagnosed live that nearly every ScrapingBee request lands on a
  // different Incapsula node, and a cookie captured on node A is
  // worthless on node B, regardless of proxy tier (stealth_proxy,
  // premium_proxy both showed this). So each product page request is
  // now fully self-contained: log in fresh, directly from this exact
  // product page. Auth0's redirect_uri preserves the originating page,
  // so after login this lands back on THIS SAME product page, already
  // authenticated - no dependency on any earlier request's cookies.
  //
  // Also confirmed live 2026-09-09: an isolated single-SKU diagnostic
  // (DIN66) worked perfectly (real price, screenshot-verified) using
  // this exact same login sequence, but the full 100-SKU production run
  // failed on every single SKU it reached - all using the SAME shared
  // SESSION_ID for every product's login. Most likely cause: repeated
  // logins under one session_id look like the same visitor hammering
  // the login form dozens of times, which is exactly the kind of
  // pattern anti-abuse systems flag. Each product now gets its own
  // fresh random session_id, so every login looks like an independent
  // new visitor rather than a repeat of the same session.
  const productSessionId = String(Math.floor(Math.random() * 1000000000));

  const html = await scrapingBeeGet(url, {
    sessionId: productSessionId,
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
        // Diagnostic screenshot (confirmed working, real price rendered)
        // used a flat 5s wait after login with no wait_for(".uc-price")
        // gate at all. Adding that gate here caused every single SKU in
        // the first full production run to fail - most likely its own
        // internal timeout was too short and aborted the scenario before
        // the post-redirect price AJAX had settled. Removed; go straight
        // from the same flat wait into the price-value poll instead.
        { wait: 5000 },
        // Same bug class as the original Playwright version: .uc-price
        // exists in the DOM almost immediately but often still shows a
        // "0.00" placeholder for several seconds before the real trade
        // price loads via AJAX. A flat wait isn't reliable - poll
        // in-page for an actual non-zero value (up to 15s) instead.
        {
          evaluate:
            "await new Promise((resolve) => { " +
            "const start = Date.now(); " +
            "const check = () => { " +
            "const el = document.querySelector('.uc-price'); " +
            "const m = el && el.textContent.match(/([\\d,]+\\.\\d{2})/); " +
            "const val = m ? parseFloat(m[1].replace(/,/g, '')) : 0; " +
            "if (val > 0 || Date.now() - start > 15000) { resolve(); return; } " +
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

  // Category listing is public - no login needed to walk it. Each
  // product page now logs in fresh, self-contained, from that exact
  // page (see scrapeCatalogProduct) - no upfront/shared login needed.
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

  // Category listing is public - no login needed to find the SKU's path.
  const listing = await walkCategoryListing();
  const item = listing.find(function (i) {
    return i.sku === sku;
  });
  if (!item || !item.productPath) {
    throw new Error("DIAGNOSTIC_SKU '" + sku + "' not found in category listing");
  }
  log("Found", sku, "at", item.productPath, "- logging in fresh from that page and taking screenshot...");

  const url = "https://hcb.co.nz" + item.productPath;
  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url: url,
    render_js: "true",
    session_id: SESSION_ID,
    stealth_proxy: "true",
    country_code: "nz",
    screenshot: "true",
    json_response: "true",
    js_scenario: JSON.stringify({
      instructions: [
        {
          evaluate:
            "Array.from(document.querySelectorAll('a')).find(a => /log ?in/i.test(a.textContent))?.click();",
        },
        { wait_for: 'input[name="email"]' },
        { fill: ['input[name="email"]', HCB_USERNAME] },
        { fill: ['input[name="password"]', HCB_PASSWORD] },
        { click: 'button[type="submit"]' },
        { wait: 5000 },
      ],
    }),
  });

  const res = await fetch("https://app.scrapingbee.com/api/v1/?" + params.toString());
  const raw = await res.text();
  if (!res.ok) {
    throw new Error("ScrapingBee screenshot request failed (" + res.status + "): " + raw.slice(0, 300));
  }
  const data = JSON.parse(raw);
  if (!data.screenshot) {
    throw new Error("ScrapingBee json_response had no screenshot field: " + raw.slice(0, 300));
  }
  const imageBuffer = Buffer.from(data.screenshot, "base64");
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
