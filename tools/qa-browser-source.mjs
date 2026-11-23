const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_URL || "playwright");
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  const page = await browser.newPage();
  await page.goto("https://iran-stock-screener.ar-nikzad09.workers.dev");
  console.log(JSON.stringify(await page.evaluate(async () => {
    const results = [];
    for (const path of ["Shareholder/GetShareHolderChanges/false", "Instrument/GetInstrumentInfo/20560887114747719", "ClosingPrice/GetClosingPriceInfo/20560887114747719", "https://zarvanfund.ir/api/instruments?syms=" + encodeURIComponent("كسرام")]) {
      try {
        const response = await fetch(path.startsWith("https:") ? path : `https://cdn.tsetmc.com/api/${path}`, { signal: AbortSignal.timeout(12000) });
        const data = await response.json();
        results.push({ path, status: response.status, dates: data.dates, count: data.shareHoldersChanges?.length, symbol: data.instrumentInfo?.lVal18AFC, date: data.closingPriceInfo?.dEven });
      } catch (error) { results.push({ path, error: error.message }); }
    }
    return results;
  })));
} finally { await browser.close(); }
