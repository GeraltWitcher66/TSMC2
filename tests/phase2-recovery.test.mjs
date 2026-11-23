import test from 'node:test';import assert from 'node:assert/strict';
import real from './fixtures/phase2-real-samples.json' with {type:'json'};
import {parseDatedClientType,parseOfficialFloor,enrichDatedClientType,officialDetails,HIGHLIGHT_BATCH_SIZE} from '../app/lib/official-details.ts';
import {instrumentFromClosingPrice} from '../app/lib/current-quotes.ts';
import {marketHighlightFromInstrument,extractMajorIndividualHoldingChanges,isSellQueueToPositive} from '../app/lib/market.ts';
import {holderSessionCoverage} from '../app/lib/market-session.ts';
import {POST as highlights} from '../app/api/market-highlights/route.ts';
import {createBrowserQuoteClient} from '../app/lib/browser-quotes.ts';
import {defaultSymbols} from '../app/default-symbols.ts';
import {loadBatches} from '../app/lib/request-lifecycle.ts';
import {createBrowserMarketClient} from '../app/lib/browser-market.ts';

for(const sample of real.samples)test(`real captured fields: ${sample.symbol}, session 20261007`,()=>{
 const quote=instrumentFromClosingPrice(sample.quote,sample.code),typed=parseDatedClientType(sample.client,sample.code,real.session),floor=parseOfficialFloor(sample.floor,real.session,sample.code);
 assert.ok(quote);assert.ok(typed);assert.ok(floor>0);assert.equal(quote.Date,real.session);
 const row=enrichDatedClientType(marketHighlightFromInstrument({...quote,Symbol:sample.symbol,InsCode:sample.code}),typed);
 const raw=sample.client.clientType;
 assert.equal(row.realBuyVolume,raw.buy_I_Volume);assert.equal(row.realSellVolume,raw.sell_I_Volume);
 assert.equal(row.realBuyCount,raw.buy_I_Count);assert.equal(row.realSellCount,raw.sell_I_Count);
 assert.equal(row.realBuyValue,raw.buy_I_Value);assert.equal(row.realSellValue,raw.sell_I_Value);assert.equal(row.netRealValue,raw.buy_I_Value-raw.sell_I_Value);
 assert.equal(raw.buy_I_Volume+raw.buy_N_Volume,quote.Volume);assert.equal(raw.sell_I_Volume+raw.sell_N_Volume,quote.Volume);
 assert.equal(raw.buy_I_Value+raw.buy_N_Value,quote.Value);assert.equal(raw.sell_I_Value+raw.sell_N_Value,quote.Value);
});
test('dated ClientType rejects wrong identity, missing date, wrong session and negative volume',()=>{
 const s=real.samples[0],p=s.client;
 assert.equal(parseDatedClientType(p,'wrong',real.session),null);assert.equal(parseDatedClientType(p,s.code,20261006),null);
 assert.equal(parseDatedClientType({clientType:{...p.clientType,recDate:null}},s.code,real.session),null);
 assert.equal(parseDatedClientType({clientType:{...p.clientType,buy_I_Volume:-1}},s.code,real.session),null);
});
test('missing real values stay null; never reconstruct them from total volume or price',()=>{
 const s=real.samples[0],raw={...s.client.clientType,buy_I_Value:undefined,sell_I_Value:null};
 const typed=parseDatedClientType({clientType:raw},s.code,real.session);
 const row=enrichDatedClientType(marketHighlightFromInstrument({Symbol:'آزمون',PriceYesterday:100,PriceLast:103,Date:real.session}),typed);
 assert.equal(row.realBuyValue,null);assert.equal(row.realSellValue,null);assert.equal(row.netRealValue,null);
});
test('official floor binds zero sentinel to requested path but rejects explicit instrument mismatch',()=>{
 const p={staticThreshold:[{insCode:'wrong',dEven:real.session,hEven:1,psGelStaMin:95}]};assert.equal(parseOfficialFloor(p,real.session,'correct'),null);
 assert.equal(parseOfficialFloor({staticThreshold:[{insCode:'0',dEven:real.session,psGelStaMin:95}]},real.session,'correct'),95);
 assert.equal(parseOfficialFloor({staticThreshold:[{insCode:'correct',dEven:20261006,psGelStaMin:95}]},real.session,'correct'),null);
 assert.equal(parseOfficialFloor({},real.session,'correct'),null);
});
test('current quote refuses explicit mismatched instrument ID',()=>{
 const sample=real.samples[0];assert.equal(instrumentFromClosingPrice({closingPriceInfo:{...sample.quote.closingPriceInfo,insCode:'other'}},sample.code),null);
});
test('real future-labelled shareholder snapshot is not backdated or treated as complete',()=>{
 const rows=extractMajorIndividualHoldingChanges(real.changes,{now:new Date('2026-10-09T08:00:00Z')});
 assert.ok(rows.every(r=>r.date===20261007));assert.equal(rows.some(r=>r.insCode==='27276541005386425'),false);
 const sample=rows.find(r=>r.insCode==='30765727085936322'&&r.currentShares===20000000);
 assert.equal(sample.previousShares,19400000);assert.equal(sample.changeShares,600000);
 const future=[20261004,20261005,20261006,20261007,29990101];assert.equal(holderSessionCoverage({dates:future}).completeForSelectedSession,false);
});
test('partial earlier-session holder summaries do not invent zero counts, on server or browser',async(t)=>{
 const payload={...real.changes,dates:[20261004,20261005,20261006,20261007,29990101]};
 const refs=[{symbol:'فجام',insCode:'30765727085936322'},{symbol:'ناشناخته',insCode:'missing'}];
 const fetch=async()=>Response.json(payload);t.mock.method(globalThis,'fetch',fetch);
 const {POST}=await import('../app/api/holder-increases/route.ts?phase2-partial');
 const server=await (await POST(new Request('http://local',{method:'POST',body:JSON.stringify({instruments:refs})}))).json();
 const browser=await createBrowserMarketClient(fetch).summaries(refs);
 for(const result of [server,browser]){assert.equal(result.partial,true);assert.equal(result.fallback,false);assert.equal(result.sourceDate,20261007);assert.equal(Object.hasOwn(result.summaries,'ناشناخته'),false);assert.equal(result.summaries['فجام'].buyShares,600000);}
});
test('official floor preserves intended reversal conditions',()=>{
 const r=marketHighlightFromInstrument({Symbol:'آزمون',InsCode:'qa',Date:real.session,AllowedMinDate:real.session,AllowedMin:95,PriceMin:95,PriceLast:103,PriceClose:98,PriceYesterday:100});
 assert.equal(isSellQueueToPositive(r),true);for(const patch of [{floorVerified:false},{touchedSellQueue:false},{lastChangePct:0},{closeChangePct:0}])assert.equal(isSellQueueToPositive({...r,...patch}),false);
});
for(const status of [403,500])test(`independent details survive ClientType HTTP ${status}; cache preserves retrieval timestamp`,async(t)=>{
 let count=0;const code='partial-'+status;
 t.mock.method(globalThis,'fetch',async u=>{count++;return String(u).includes('ClientType')?new Response('error',{status}):Response.json({staticThreshold:[{insCode:code,dEven:real.session,psGelStaMin:95}]});});
 const row=marketHighlightFromInstrument({Symbol:'آزمون',InsCode:code,Date:real.session,PriceLast:103,PriceMin:95,PriceClose:98,PriceYesterday:100});
 const [first]=await officialDetails([row]);assert.equal(first.floorVerified,true);assert.equal(first.clientTypeAvailable,false);
 const [second]=await officialDetails([row]);assert.equal(second.floorFetchedAt,first.floorFetchedAt);assert.equal(count,3);
});
test('completed official details are not fetched again by browser enrichment',async()=>{
 let calls=0;const row={symbol:'آزمون',insCode:'qa',sessionDate:real.session,clientTypeDate:real.session,clientTypeAvailable:true,floorVerified:true};
 const result=await createBrowserQuoteClient(async()=>{calls++;throw Error('unexpected');}).highlights([row]);assert.deepEqual(result,[row]);assert.equal(calls,0);
});
test('highlights rejects oversized batches before any provider call',async(t)=>{
 const fetch=t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected');});const r=await highlights(new Request('http://local',{method:'POST',body:JSON.stringify({symbols:Array(HIGHLIGHT_BATCH_SIZE+1).fill('آزمون')})}));assert.equal(r.status,400);assert.equal(fetch.mock.callCount(),0);
});
test('configured watchlist workflow is bounded to ten symbols and two requests; partial results survive',async()=>{
 const batches=[];for(let i=0;i<defaultSymbols.length;i+=HIGHLIGHT_BATCH_SIZE)batches.push(defaultSymbols.slice(i,i+HIGHLIGHT_BATCH_SIZE));
 let active=0,max=0,attempts=0;const seen=[];
 const result=await loadBatches(batches,async batch=>{active++;max=Math.max(max,active);attempts++;await new Promise(r=>setTimeout(r,1));active--;seen.push(...batch);return{rows:batch.slice(0,-1),partial:true};},{budgetMs:2000,attemptMs:1000});
 assert.equal(defaultSymbols.length,178);assert.equal(result.expired,false);assert.equal(result.results.length,18);assert.equal(attempts,18);assert.equal(max,2);assert.equal(seen.length,178);assert.ok(batches.every(b=>b.length<=10));
});
