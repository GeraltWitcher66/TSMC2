const base = "https://cdn.tsetmc.com/api";
for (const path of ["ClosingPrice/GetMarketWatch/0", "ClosingPrice/GetClosingPriceInfo/20560887114747719", "MarketData/GetMarketOverview/1"]) {
  try {
    const response = await fetch(`${base}/${path}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0", Referer: "https://tsetmc.com/" }, signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    console.log(JSON.stringify({ path, status: response.status, keys: Object.keys(data), fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Array.isArray(value) ? { count: value.length, example: value.find((item) => String(item.insCode) === "20560887114747719") ?? value[0] } : value])) }));
  } catch (error) { console.log(JSON.stringify({ path, error: error.message })); }
}
