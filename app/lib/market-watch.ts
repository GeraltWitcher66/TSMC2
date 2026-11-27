/**
 * The whole-market watch request.
 *
 * `GetMarketWatch` answers empty without its standard query, so both routes
 * that read it must ask for exactly the same thing: the browser's direct CDN
 * call and the relay's fallback. `showTraded=false` keeps instruments that did
 * not trade today in the list — the relay asking for `true` used to drop three
 * sector codes and hundreds of funds, so the card changed with the transport.
 */
export const MARKET_WATCH_QUERY = [
  "market=0", "industrialGroup=", "showTraded=false", "withBestLimits=false", "hEven=0", "RefID=0",
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => `paperTypes%5B${index}%5D=${index + 1}`),
].join("&");

/** Path plus query, ready for the direct read (the relay adds the query itself). */
export const MARKET_WATCH_PATH = `ClosingPrice/GetMarketWatch?${MARKET_WATCH_QUERY}`;
