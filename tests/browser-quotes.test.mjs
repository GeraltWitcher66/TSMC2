import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserQuoteClient, officialSessionFloor } from '../app/lib/browser-quotes.ts';
import { isSellQueueToPositive, marketHighlightFromInstrument } from '../app/lib/market.ts';
import { recalculateScreenerRow } from '../app/lib/screener-analysis.ts';
import { divergenceSeries, asOf } from './helpers/divergence-series.mjs';
import real from './fixtures/phase2-real-samples.json' with { type: 'json' };
import { instrumentFromClosingPrice } from '../app/lib/current-quotes.ts';
import { lastClosedEquitySession } from '../app/lib/market-session.ts';

test('the customer Visa and Foulai examples never touched their same-day allowed floors', () => {
  for (const [symbol,min,floor,last,close,yesterday] of [['ویسا',4740,4640,4800,4670,4780],['فولای',4530,4430,4620,4550,4560]]) {
    const row=marketHighlightFromInstrument({Symbol:symbol,Date:20260908,AllowedMinDate:20260908,PriceMin:min,AllowedMin:floor,PriceLast:last,PriceClose:close,PriceYesterday:yesterday});
    assert.equal(isSellQueueToPositive(row),false);
  }
  const exact=marketHighlightFromInstrument({Symbol:'الف',Date:20260908,AllowedMinDate:20260908,PriceMin:4430,AllowedMin:4430,PriceLast:4620,PriceClose:4550,PriceYesterday:4560});
  assert.equal(isSellQueueToPositive(exact),true);
  assert.equal(isSellQueueToPositive({...exact,floorVerified:false}),false);
});
test('official allowed-price records are selected by exact session and newest intra-session revision', () => {
  const payload={staticThreshold:[{dEven:20260908,hEven:1,psGelStaMin:4430},{dEven:20260909,hEven:60124,psGelStaMin:4420},{dEven:20260909,hEven:1,psGelStaMin:4400}]};
  assert.equal(officialSessionFloor(payload,20260908),4430);
  assert.equal(officialSessionFloor(payload,20260909),4420);
  assert.equal(officialSessionFloor(payload,20260907),null);
});
const sourceRow = () => {
  const candles=divergenceSeries();
  return {symbol:'الف',insCode:'1',rsi:null,realHolders:null,actions:[],three:null,six:null,status:'warning',quoteVerified:false,analysisInput:{candles,changes:[],eps:10,pe:10,sectorPe:12}};
};
test('unverified freshness downgrades the label but never erases the day-over-day classification', () => {
  const row=sourceRow(), c=row.analysisInput.candles;
  const safe=recalculateScreenerRow(row,c,[],false,asOf(c));
  assert.ok(safe.divergenceAnalysis,'an unverified intraday quote must not erase the analysis computed from closed candles');
  assert.ok(['positive','negative','none'].includes(safe.divergenceAnalysis.status), safe.divergenceAnalysis.status);
  if (safe.divergence) {
    assert.equal(safe.divergence, safe.divergenceAnalysis.divergence);
  }
  assert.equal(safe.status,'warning');
  assert.match(safe.note,/تازگی قیمت لحظه‌ای تأیید نشد/);
  assert.equal(safe.three.currentPrice,86);
  const verified=recalculateScreenerRow(row,c,[],true,asOf(c));
  assert.ok(['positive','negative','none'].includes(verified.divergenceAnalysis.status), verified.divergenceAnalysis.status);
  assert.equal(verified.status,'ready');
});
test('browser refresh recalculates all metrics with dated official prices', async () => {
  const row=sourceRow();
  const client=createBrowserQuoteClient(async(url)=>new Response(JSON.stringify(url.includes('GetClosingPriceInfo')?{closingPriceInfo:{dEven:20260909,priceMax:121,priceMin:119,pClosing:120,pDrCotVal:120,priceFirst:120,priceYesterday:119,qTotTran5J:10}}:{closingPriceDaily:[]})));
  const [fresh]=await client.refresh([row]);
  assert.equal(fresh.three.currentDate,'20260909');assert.equal(fresh.three.currentPrice,120);
  assert.equal(fresh.valuation.epsSectorPeUpsidePct,0);assert.equal(fresh.quoteVerified,true);
});
test('browser refuses official-looking current quotes explicitly bound to a different InsCode', async () => {
  const row=sourceRow();
  let currentCalls=0;
  const client=createBrowserQuoteClient(async(url) => {
    if(String(url).includes('GetClosingPriceInfo')) {
      currentCalls++;
      return Response.json({closingPriceInfo:{insCode:'999',dEven:20260909,priceMax:121,priceMin:119,pClosing:120,pDrCotVal:120,priceFirst:120,priceYesterday:119,qTotTran5J:10}});
    }
    return Response.json({closingPriceDaily:[]});
  });
  const [recovered]=await client.refresh([row]);
  assert.equal(currentCalls,1);
  assert.equal(recovered.quoteVerified,false);
  assert.equal(recovered.priceQuote??null,null);
});
test('unavailable browser source and cancelled scans preserve the old row without claiming a refresh', async () => {
  const row=sourceRow();let calls=0;
  const client=createBrowserQuoteClient(async()=>{calls++;throw Error('network');});
  assert.deepEqual(await client.refresh([row],()=>false),[row]);assert.equal(calls,0);
  // Each endpoint is tried directly and then once through the Worker relay.
  assert.deepEqual(await client.refresh([row]),[row]);assert.equal(calls,4);
});
test('a once-verified old quote is rechecked for a later session; current-session verified quote is not refetched', async () => {
  let calls=0;
  const original=sourceRow();
  const stale={...original,quoteVerified:true,priceQuote:{closeRial:86,sessionDate:20260908},divergenceAnalysis:{status:'none'}};
  const current={...stale,priceQuote:{closeRial:86,sessionDate:lastClosedEquitySession()}};
  const client=createBrowserQuoteClient(async()=>{calls++;throw Error('network unavailable');});
  await client.refresh([stale]);
  assert.equal(calls,4,'stale verified source must be eligible for a bounded official retry');
  calls=0;
  assert.deepEqual(await client.refresh([current]),[current]);
  assert.equal(calls,0,'already verified current session should not be queried again');
});
test('when the browser cannot reach TSETMC directly, the Worker relay lifts the row to the newest official session', async () => {
  const row=sourceRow();
  const history={closingPriceDaily:[{dEven:20260909,priceMax:87,priceMin:85,pClosing:86,priceFirst:86,priceYesterday:85},{dEven:20260908,priceMax:86,priceMin:84,pClosing:85,priceYesterday:84}]};
  const client=createBrowserQuoteClient(async(url)=>{
    if(url.startsWith('https://cdn.tsetmc.com')) throw Error('blocked (VPN exit)');
    if(url.startsWith('/api/tsetmc-relay?path=')) {
      const path=decodeURIComponent(new URL(url, 'https://relay.local').searchParams.get('path'));
      if(path.startsWith('ClosingPrice/GetClosingPriceDailyList')) return Response.json(history);
      if(path.startsWith('ClosingPrice/GetClosingPriceInfo')) return Response.json({closingPriceInfo:null});
    }
    throw Error(`Unexpected ${url}`);
  });
  const [fresh]=await client.refresh([row]);
  assert.equal(fresh.priceQuote.sessionDate,20260909);
  assert.equal(fresh.three,null,'a two-session official relay is not 90-day performance evidence');
  assert.equal(fresh.quoteVerified,false);
});
test('a late browser refresh never replaces the newly selected watchlist', async () => {
  const row=sourceRow();let current=true,release;
  const gate=new Promise(r=>{release=r;});
  const client=createBrowserQuoteClient(async()=>{await gate;return new Response('{}');});
  const promise=client.refresh([row],()=>current);current=false;release();
  assert.deepEqual(await promise,[row]);
});

test('highlight detail source hedges a blocked direct lookup and accepts only official same-session ClientType and floor', async () => {
  const sample = real.samples[1];
  const base = marketHighlightFromInstrument({ ...instrumentFromClosingPrice(sample.quote, sample.code), Symbol: sample.symbol, InsCode: sample.code });
  let directCalls = 0, relayCalls = 0;
  const client = createBrowserQuoteClient(async (url, init) => {
    if (String(url).startsWith('https://cdn.tsetmc.com')) {
      directCalls++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ clientType: null })), 200);
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
      });
    }
    if (String(url).startsWith('/api/tsetmc-relay?path=')) {
      relayCalls++;
      const path = new URL(String(url), 'https://worker.local').searchParams.get('path');
      if (path.startsWith('ClientType/')) return Response.json(sample.client);
      if (path.startsWith('MarketData/')) return Response.json(sample.floor);
    }
    throw Error(`Unexpected endpoint ${url}`);
  }, { detailHedgeDelayMs: 5 });
  const [row] = await client.details([base]);
  assert.equal(directCalls, 2);
  assert.equal(relayCalls, 2);
  assert.equal(row.clientTypeDate, real.session);
  assert.equal(row.netRealValue, sample.client.clientType.buy_I_Value - sample.client.clientType.sell_I_Value);
  assert.equal(row.floorVerified, true);
  assert.equal(row.floorDate, real.session);
  assert.equal(row.allowedMin, sample.floor.staticThreshold.find(x => x.dEven === real.session).psGelStaMin);
});
