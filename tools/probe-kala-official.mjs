// Does کالا have an official share change around its June gap?
const insRes = await fetch("https://zarvanfund.ir/api/instruments?" + new URLSearchParams({ symbol: "کالا" }));
let insCode = null;
try { const j = await insRes.json(); insCode = (j["کالا"] ?? Object.values(j)[0])?.InsCode; } catch {}
console.log("insCode:", insCode);
if (insCode) {
  const res = await fetch(`https://cdn.tsetmc.com/api/Instrument/GetInstrumentShareChange/${encodeURIComponent(insCode)}`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0", Referer: "https://tsetmc.com/" },
  });
  console.log("share-change HTTP:", res.status);
  const text = await res.text();
  console.log(text.slice(0, 500));
}
