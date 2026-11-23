import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamJson } from '../app/lib/upstream.ts';
import { sourceSession, instrumentSession, instrumentFromDailyRows, datedClientType, preserveHighlightRows } from '../app/lib/market-session.ts';
import { createBrowserQuoteClient, officialSessionFloor } from '../app/lib/browser-quotes.ts';
import { marketHighlightFromInstrument, isSellQueueToPositive } from '../app/lib/market.ts';
import { POST as highlights } from '../app/api/market-highlights/route.ts';
import { POST as screener } from '../app/api/screener/route.ts';
import { POST as holders } from '../app/api/holder-increases/route.ts';
import { RequestCoalescer } from '../app/lib/data-reliability.ts';
const day=20261007;
const daily={d_even:day,high:104,low:95,close:98,last:103,open:99,yesterday:100,volume:1000,value:98000};
const quote={closingPriceInfo:{dEven:day,priceMax:104,priceMin:95,pClosing:98,pDrCotVal:103,priceFirst:99,priceYesterday:100,qTotTran5J:1000,qTotCap:98000}};
const typed={dEven:day,buy_I_Volume:600,sell_I_Volume:400,buy_N_Volume:400,sell_N_Volume:600,buy_CountI:6,sell_CountI:8};
const never=()=>new Promise(()=>{});
const url='https://cdn.tsetmc.com/api/test?secret=never-log';

test('valid recent JSON is parsed and diagnostics omit query/body/header secrets',async()=>{
 const events=[];const value=await upstreamJson(url,{timeoutMs:100,observe:e=>events.push(e),request:async()=>Response.json({dEven:day})});
 assert.equal(value.dEven,day);assert.equal(events[0].stage,'complete');assert.equal(events[0].code,'OK');assert.doesNotMatch(JSON.stringify(events),/secret|never-log/);
});
for(const status of [403,500]) test(`provider HTTP ${status} is distinct from timeout`,async()=>{
 await assert.rejects(upstreamJson(url,{timeoutMs:100,request:async()=>new Response('blocked',{status})}),e=>e.diagnostic.code===`PROVIDER_HTTP_${status}`&&e.diagnostic.status===status);
});
for(const body of ['<html>security restriction</html>','{broken']) test(`invalid JSON is rejected: ${body}`,async()=>{
 await assert.rejects(upstreamJson(url,{timeoutMs:100,request:async()=>new Response(body)}),e=>e.diagnostic.code==='PROVIDER_INVALID_RESPONSE'&&e.diagnostic.stage==='parse');
});
test('transport failure does not invent a Cloudflare/DNS/TLS cause',async()=>{
 await assert.rejects(upstreamJson(url,{timeoutMs:100,request:async()=>{throw TypeError('fetch failed');}}),e=>e.diagnostic.code==='UPSTREAM_NETWORK_FAILURE'&&e.diagnostic.stage==='headers');
});
test('headers stalled: deadline bounds an uncooperative transport',async()=>{
 await assert.rejects(upstreamJson(url,{timeoutMs:10,request:never}),e=>e.diagnostic.code==='REQUEST_TIMEOUT'&&e.diagnostic.stage==='headers');
});
test('body stalled: deadline retains HTTP status and body-stage provenance',async()=>{
 await assert.rejects(upstreamJson(url,{timeoutMs:10,request:async()=>new Response(new ReadableStream({start(){}}))}),e=>e.diagnostic.code==='REQUEST_TIMEOUT'&&e.diagnostic.stage==='body'&&e.diagnostic.status===200);
});
test('schema mismatch is not an empty successful feed',async()=>{
 await assert.rejects(upstreamJson(url,{timeoutMs:100,validate:v=>Array.isArray(v.clientTypeAllDto),request:async()=>Response.json({wrong:[]})}),e=>e.diagnostic.code==='PROVIDER_SCHEMA_MISMATCH');
});
test('already cancelled request does not access upstream',async()=>{
 let calls=0;await assert.rejects(upstreamJson(url,{timeoutMs:100,signal:AbortSignal.abort(),request:async()=>{calls++;return Response.json({});}}),e=>e.diagnostic.code==='REQUEST_CANCELLED');assert.equal(calls,0);
});
test('successful request clears timeout and parent abort listener',async()=>{
 const parent=new AbortController();let signal;let adds=0,removes=0;
 const add=parent.signal.addEventListener.bind(parent.signal),remove=parent.signal.removeEventListener.bind(parent.signal);
 parent.signal.addEventListener=(...args)=>{adds++;return add(...args);};parent.signal.removeEventListener=(...args)=>{removes++;return remove(...args);};
 await upstreamJson(url,{timeoutMs:10,signal:parent.signal,request:async(_url,init)=>{signal=init.signal;return Response.json({});}});
 await new Promise(r=>setTimeout(r,20));assert.equal(signal.aborted,false);assert.equal(adds,removes);
});
test('missing, malformed, impossible and future sessions stay unknown',()=>{
 for(const value of [null,0,'',20260230,20261301,29990101]) assert.equal(sourceSession(value),null);
 assert.equal(instrumentSession({Date:0,DEven:day}),day);
 assert.equal(sourceSession(day),day);
});
test('dated daily rows replace a full quote without invented floor or money flow',()=>{
 const row=instrumentFromDailyRows([daily]);assert.equal(row.Date,day);assert.equal(row.PriceClose,98);assert.equal(row.AllowedMinDate,null);assert.equal(row.NetRealValue,null);
 assert.equal(instrumentFromDailyRows([{...daily,d_even:0}]),null);assert.equal(instrumentFromDailyRows([{...daily,volume:null}]),null);
});
test('ClientType requires its own matching source session and complete finite volumes',()=>{
 assert.ok(datedClientType(typed,day));assert.equal(datedClientType({...typed,dEven:20261006},day),null);assert.equal(datedClientType({...typed,dEven:undefined},day),null);assert.equal(datedClientType({...typed,buy_I_Volume:null},day),null);assert.equal(datedClientType(typed,null),null);
});
test('floor requires exact session and finite positive value',()=>{
 const payload={staticThreshold:[{dEven:day,hEven:1,psGelStaMin:95},{dEven:20261006,hEven:2,psGelStaMin:90}]};
 assert.equal(officialSessionFloor(payload,day),95);assert.equal(officialSessionFloor(payload,20261005),null);assert.equal(officialSessionFloor({staticThreshold:[{dEven:day,psGelStaMin:Infinity}]},day),null);
});
test('DEven mapping restores date and cannot verify a zero daily floor',()=>{
 const row=marketHighlightFromInstrument({Symbol:'آزمون',DEven:day,AllowedMinDate:day,AllowedMin:0,PriceYesterday:100,PriceLast:103,PriceClose:98});assert.equal(row.sessionDate,day);assert.equal(row.floorVerified,false);
});
test('quote success survives independent floor failure; no cross-session ClientType carryover',async()=>{
 const original=marketHighlightFromInstrument({Symbol:'آزمون',InsCode:'browser-test',Date:20261006,PriceYesterday:100,PriceLast:100,PriceClose:100,NetRealValue:55},typed);
 const client=createBrowserQuoteClient(async u=>String(u).includes('GetClosingPriceInfo')?Response.json(quote):new Response('error',{status:500}));
 const [row]=await client.highlights([original]);assert.equal(row.sessionDate,day);assert.equal(row.priceLast,103);assert.equal(row.floorVerified,false);assert.equal(row.clientTypeAvailable,false);assert.equal(row.netRealValue,null);assert.equal(isSellQueueToPositive(row),false);
});
test('older official quote cannot overwrite a newer valid quote',async()=>{
 const row=marketHighlightFromInstrument({Symbol:'آزمون',InsCode:'old',Date:day,PriceYesterday:100,PriceLast:103});
 const client=createBrowserQuoteClient(async()=>Response.json({closingPriceInfo:{...quote.closingPriceInfo,dEven:20261006}}));assert.deepEqual(await client.highlights([row]),[row]);
});
test('same-session official floor enables only the exact reversal rule',async()=>{
 const row=marketHighlightFromInstrument({Symbol:'آزمون',InsCode:'floor',Date:day,PriceYesterday:100,PriceLast:103});
 const client=createBrowserQuoteClient(async u=>String(u).includes('GetClosingPriceInfo')?Response.json(quote):Response.json({staticThreshold:[{dEven:day,hEven:1,psGelStaMin:95}]}));
 const [fresh]=await client.highlights([row]);assert.equal(fresh.floorVerified,true);assert.equal(isSellQueueToPositive(fresh),true);
});
test('highlights recovers dated daily data while explicitly retaining ClientType and floor gaps',async(t)=>{
 t.mock.method(globalThis,'fetch',async u=>{
  if(String(u).includes('/instruments?'))return Response.json({'آزمون':{Symbol:'آزمون',InsCode:'daily-test',Date:0,PriceLast:999,PriceClose:999,PriceYesterday:100,AllowedMin:95,NetRealValue:123}});
  if(String(u).includes('daily-batch'))return Response.json({'آزمون':[daily]});
  return new Response('blocked',{status:403});
 });
 const r=await (await highlights(new Request('http://local',{method:'POST',body:JSON.stringify({symbols:['آزمون']})}))).json();
 assert.equal(r.latestDate,day);assert.equal(r.rows[0].priceLast,103);assert.equal(r.rows[0].netRealValue,null);assert.equal(r.rows[0].floorVerified,false);assert.equal(r.clientTypeUnavailable,true);assert.equal(r.partial,true);assert.ok(r.diagnostics.some(d=>d.code==='PROVIDER_HTTP_403'));
});
test('partially missing ClientType is flagged even when provider HTTP succeeds',async(t)=>{
 t.mock.method(globalThis,'fetch',async u=>{
  if(String(u).includes('ClientType'))return Response.json({clientTypeAllDto:[{insCode:'ct-a',...typed}]});
  if(String(u).includes('/instruments?'))return Response.json({'الف':{InsCode:'ct-a',Date:day,PriceYesterday:100,PriceLast:103},'ب':{InsCode:'ct-b',Date:day,PriceYesterday:100,PriceLast:103}});
  return Response.json(quote);
 });
 const r=await (await highlights(new Request('http://local',{method:'POST',body:JSON.stringify({symbols:['الف','ب']})}))).json();
 assert.equal(r.rows.length,2);assert.equal(r.rows[0].clientTypeAvailable,true);assert.equal(r.rows[1].clientTypeAvailable,false);assert.equal(r.clientTypeUnavailable,true);
});
test('screener cannot invent next-session candle from a matching previous close',async(t)=>{
 t.mock.method(globalThis,'fetch',async u=>{
  if(String(u).includes('daily-batch'))return Response.json({'آزمون':[{...daily,d_even:20261006,close:100}]});
  if(String(u).includes('/instruments?'))return Response.json({'آزمون':{Date:0,PriceYesterday:100,PriceClose:103,PriceMin:101,PriceMax:105,Volume:1000}});
  return Response.json({});
 });
 const r=await (await screener(new Request('http://local',{method:'POST',body:JSON.stringify({symbols:['آزمون']})}))).json();assert.equal(r.latestDate,20261006);assert.equal(r.rows[0].priceQuote.closeRial,100);assert.equal(r.rows[0].three,null);
});
test('historical fallback retains original date and structured upstream failure',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('denied',{status:403}));
 const r=await (await holders(new Request('http://local',{method:'POST',body:JSON.stringify({view:'rows',symbols:['فنر']})}))).json();assert.equal(r.sourceDate,20260907);assert.equal(r.fallback,true);assert.equal(r.delivery,'bundled');assert.equal(r.diagnostics.upstream.code,'PROVIDER_HTTP_403');assert.equal(r.diagnostics.outcome,'FALLBACK_BUNDLED');
});
test('cache preserves values and does not store failed refreshes',async()=>{
 const cache=new RequestCoalescer(10,2);let calls=0;const load=async()=>({date:day,n:++calls});const a=await cache.run('x',load);assert.deepEqual(await cache.run('x',load),a);assert.equal(calls,1);await new Promise(r=>setTimeout(r,15));await assert.rejects(cache.run('x',async()=>{throw Error('failure');}));assert.equal((await cache.run('x',load)).n,2);
});
test('partial and undated refreshes preserve newer rows with cache provenance',()=>{
 const before=[{symbol:'الف',sessionDate:day,price:103,quoteFetchedAt:'original'},{symbol:'ب',sessionDate:day,price:98}];
 const merged=preserveHighlightRows(before,[{symbol:'الف',sessionDate:null,price:999},{symbol:'ج',sessionDate:day,price:50}],['الف','ب','ج']);
 assert.equal(merged.retained,2);assert.deepEqual(merged.rows[0],{...before[0],delivery:'cache'});assert.equal(merged.rows[1].price,98);assert.equal(merged.rows[2].price,50);
 assert.deepEqual(preserveHighlightRows(before,[],['ج']).rows,[]);
});
