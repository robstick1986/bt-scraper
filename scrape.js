// Drives a real headless browser through batterytown.co.nz's number-plate
// search and extracts the vehicle info + Battery Town's own recommended
// battery(ies) for that vehicle.
//
// WHY A REAL BROWSER: batterytown.co.nz's internal AJAX endpoint
// (POST /vsapi/getplateresult) sits behind Imperva/Incapsula bot protection
// plus a device-fingerprint cookie, and rejects requests that don't come
// from a genuine browser session. Driving an actual headless browser
// respects that (real page load, real JS execution, real cookies) instead
// of trying to replay/spoof the API call directly.

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

    await page.goto("https://batterytown.co.nz/number-plate-search", {
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

    await page.waitForTimeout(1000);

    const bodyText = await page.evaluate(() => document.body.innerText);

    if (/not found|no results/i.test(bodyText) && !/Make:/i.test(bodyText)) {
      return { plate: plate.toUpperCase(), found: false, vehicle: null, products: [] };
    }

    const vehicleMatch = bodyText.match(
      /Make:\s*([^\n]+?)\s*Model:\s*([^\n]+?)\s*Year:\s*([^\n]+?)\s*Series Chassis:\s*([^\n]+?)\s*Engine:\s*([^\n]+)/
    );

    // Each result card has a bold SKU heading, a "With/Without Stop/Start"
    // line, then CCA and Technology bullets. Walk the DOM for elements
    // containing "CCA:" and climb to the smallest ancestor that also
    // contains the SKU heading text.
    const products = await page.evaluate(() => {
      const cards = [];
      const ccaEls = Array.from(document.querySelectorAll("body *")).filter((el) =>
        /^CCA:\s*\d+/.test((el.innerText || "").trim())
      );
      const seen = new Set();
      for (const el of ccaEls) {
        let container = el.closest("div");
        for (let i = 0; i < 5 && container; i++) {
          const t = container.innerText || "";
          if (/CCA:/.test(t) && t.length < 700 && t.length > 10) break;
          container = container.parentElement;
        }
        if (container && !seen.has(container)) {
          seen.add(container);
          const text = container.innerText.trim();
          const skuMatch = text.match(/^([A-Za-z0-9\/\-]+)/);
          const ccaMatch = text.match(/CCA:\s*(\d+)/i);
          const techMatch = text.match(/Technology:\s*([^\n]+)/i);
          const stopStartMatch = text.match(/(With|Without)\s*Stop\s*\/?\s*Start/i);
          cards.push({
            sku: skuMatch ? skuMatch[1] : null,
            cca: ccaMatch ? parseInt(ccaMatch[1], 10) : null,
            technology: techMatch ? techMatch[1].trim() : null,
            stopStart: stopStartMatch ? /^With/i.test(stopStartMatch[0]) : null,
            rawText: text,
          });
        }
      }
      return cards;
    });

    return {
      plate: plate.toUpperCase(),
      found: !!vehicleMatch || products.length > 0,
      vehicle: vehicleMatch
        ? {
            make: vehicleMatch[1].trim(),
            model: vehicleMatch[2].trim(),
            year: vehicleMatch[3].trim(),
            seriesChassis: vehicleMatch[4].trim(),
            engine: vehicleMatch[5].trim(),
          }
        : null,
      products,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapePlate };

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
