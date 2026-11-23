import test from 'node:test';import assert from 'node:assert/strict';
import {POST as highlights} from '../app/api/market-highlights/route.ts';
import {POST as screener} from '../app/api/screener/route.ts';
import {createBrowserQuoteClient} from '../app/lib/browser-quotes.ts';
import {highlightCoverage,emptyDataMessage} from '../app/lib/data-coverage.ts';
import {loadBatches,withDeadline} from '../app/lib/request-lifecycle.ts';
import {marketHighlightFromInstrument} from '../app/lib/market.ts';
import {preferHolderSource} from '../app/lib/market-session.ts';
import real from './fixtures/phase2-real-samples.json' with {type:'json'};
const day=20261007,daily={d_even:day,high:104,low:95,close:98,last:103,open:99,yesterday:100,volume:1000,value:98000};
const request=body=>new Request('http://local',{method:'POST',body:JSON.stringify(body)});
const base=()=>marketHighlightFromInstrument({Symbol:'فنر',InsCode:real.samples[1].code,Date:day,PriceLast:100,PriceClose:100,PriceYesterday:100,PriceMin:95,Volume:1000,Value:100000});
test('ranking price stage returns every dated price without waiting for unavailable official details',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async u=>{calls.push(String(u));if(String(u).includes('tsetmc'))throw Error('official must not gate base prices');return Response.json(String(u).includes('daily-batch')?{'الف':[daily],'ب':[daily]}:{'الف':{InsCode:'1',Date:0},'ب':{InsCode:'2',Date:0}});});
 const r=await(await highlights(request({symbols:['الف','ب'],pricesOnly:true}))).json();assert.equal(r.rows.length,2);assert.equal(r.partial,false);assert.equal(r.coverage.datedPrices,2);assert.equal(r.coverage.clientType,0);assert.equal(calls.length,2);assert.equal(r.rows[0].netRealValue,null);
});
test('dated but stale instrument snapshot is replaced by newer dated daily price',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async u=>{
  calls.push(String(u));
  return Response.json(String(u).includes('daily-batch')?{'الف':[{...daily,d_even:20261014,high:118,last:115,close:113}]}:{'الف':{InsCode:'1',Date:20261007,PriceLast:90,PriceClose:90,PriceYesterday:100,Volume:1000,Value:90000}});
 });
 const response=await highlights(request({symbols:['الف'],pricesOnly:true}));
 const result=await response.json();
 assert.equal(response.status,200);
 assert.equal(result.rows[0].sessionDate,20261014);
 assert.equal(result.rows[0].priceLast,115);
 assert.equal(result.rows[0].netRealValue,null);
 assert.equal(result.rows[0].floorVerified,false);
 assert.ok(calls.some(url=>url.includes('daily-batch')));
});
test('highlights prefer a genuinely traded daily candle over a zero-volume contradictory same-day snapshot',async t=>{
 const original={InsCode:'1',Date:20261024,PriceMin:700,PriceMax:720,PriceClose:659,PriceLast:661,PriceYesterday:650,Volume:0,Value:0,AllowedMin:640,AllowedMinDate:20261024,NetRealValue:123};
 const traded={d_even:20261024,high:677,low:650,close:659,last:661,open:656,yesterday:650,volume:1000,value:659000};
 t.mock.method(globalThis,'fetch',async u=>Response.json(String(u).includes('daily-batch')?{'الف':[traded]}:{'الف':original}));
 const result=await(await highlights(request({symbols:['الف'],pricesOnly:true}))).json();
 assert.equal(result.outcomes[0].price,'received');
 assert.equal(result.rows.length,1);
 assert.equal(result.rows[0].quoteSource,'zarvan-daily');
 assert.equal(result.rows[0].sessionDate,20261024);
 assert.equal(result.rows[0].volume,1000);
 assert.equal(result.rows[0].priceMin,650);
 assert.equal(result.rows[0].netRealValue,null);
 assert.equal(result.rows[0].floorVerified,false);
});
test('impossible daily and non-traded snapshot cannot become dated highlights',async t=>{
 const original={InsCode:'1',Date:20261024,PriceMin:700,PriceMax:720,PriceClose:659,PriceLast:661,PriceYesterday:650,Volume:0};
 const badDaily={d_even:20261024,high:100,low:650,close:659,last:661,open:656,yesterday:650,volume:1000,value:659000};
 t.mock.method(globalThis,'fetch',async u=>Response.json(String(u).includes('daily-batch')?{'الف':[badDaily]}:{'الف':original}));
 const result=await(await highlights(request({symbols:['الف'],pricesOnly:true}))).json();
 assert.equal(result.rows.length,0);
 assert.equal(result.latestDate,null);
 assert.equal(result.outcomes[0].price,'date_unverified');
 assert.equal(result.partial,true);
});
test('valid traded snapshot preserves same-session priority over daily, but a newer daily wins',async t=>{
 const original={InsCode:'1',Date:20261021,PriceMin:640,PriceMax:680,PriceClose:659,PriceLast:661,PriceYesterday:650,Volume:1234,Value:100000};
 let dailyDate=20261021;
 t.mock.method(globalThis,'fetch',async u=>Response.json(String(u).includes('daily-batch')?{'الف':[{...daily,d_even:dailyDate,high:680,low:640,close:659,last:663,yesterday:650}]}:{'الف':original}));
 let result=await(await highlights(request({symbols:['الف'],pricesOnly:true}))).json();
 assert.equal(result.rows[0].quoteSource,'zarvan-instruments');
 assert.equal(result.rows[0].volume,1234);
 dailyDate=20261024;
 result=await(await highlights(request({symbols:['الف'],pricesOnly:true}))).json();
 assert.equal(result.rows[0].quoteSource,'zarvan-daily');
 assert.equal(result.rows[0].sessionDate,20261024);
 assert.equal(result.rows[0].volume,1000);
});
test('ranking distinguishes omitted instruments and unverified dates',async t=>{
 t.mock.method(globalThis,'fetch',async u=>Response.json(String(u).includes('daily-batch')?{}:{'الف':{InsCode:'1',Date:0,PriceLast:100,PriceClose:100}}));
 const r=await(await highlights(request({symbols:['الف','ب'],pricesOnly:true}))).json();assert.equal(r.outcomes[0].price,'date_unverified');assert.equal(r.outcomes[1].price,'instrument_missing_in_response');
});
test('screener keeps successful histories and identities while explaining a separately empty record',async t=>{
 t.mock.method(globalThis,'fetch',async u=>Response.json(String(u).includes('daily-batch')?{'الف':[daily],'ب':[]}:{'الف':{InsCode:'1'},'ب':{InsCode:'2'}}));
 const r=await(await screener(request({symbols:['الف','ب'],baseOnly:true}))).json();assert.equal(r.coverage.requested,2);assert.equal(r.coverage.computed,0);assert.equal(r.rows[1].insCode,'2');assert.equal(r.rows[0].priceQuote.sessionDate,day);assert.equal(r.rows[0].three,null,'one dated candle must not invent a full period');assert.match(r.rows[1].note,/پاسخ منبع/);
});
test('screener upstream failure is not labelled absent from source',async t=>{
 t.mock.method(globalThis,'fetch',async u=>String(u).includes('daily-batch')?new Response('bad',{status:500}):Response.json({'الف':{InsCode:'1'}}));
 const r=await(await screener(request({symbols:['الف'],baseOnly:true}))).json();assert.match(r.rows[0].note,/ناموفق/);assert.equal(r.diagnostics.some(x=>x.code==='PROVIDER_HTTP_500'),true);
});
test('recent partial shareholder source supersedes an older complete bundled snapshot without mixing rows',()=>{
 const server={sourceDate:20260907,fallback:true,partial:false,rows:Array(10).fill({})};
 assert.equal(preferHolderSource(server,{sourceDate:day,partial:true,rows:[{}]}),true);
 assert.equal(preferHolderSource(server,{sourceDate:20260906,partial:true,rows:[{}]}),false);
 assert.equal(preferHolderSource({...server,sourceDate:day,fallback:false},{sourceDate:day,partial:true,rows:[{}]}),false);
});
test('dated browser details do not request a quote first and preserve source values',async()=>{
 const calls=[],s=real.samples[1];const c=createBrowserQuoteClient(async u=>{calls.push(String(u));return Response.json(String(u).includes('ClientType')?s.client:s.floor);});
 const [r]=await c.details([base()]);assert.equal(calls.length,2);assert.ok(calls.every(u=>!u.includes('ClosingPrice')));assert.equal(r.realBuyValue,s.client.clientType.buy_I_Value);assert.equal(r.floorVerified,true);assert.equal(r.sessionDate,day);
});
test('a completed floor survives a stalled ClientType and overall deadline',async()=>{
 let latest=[base()];const c=createBrowserQuoteClient(async u=>String(u).includes('ClientType')?new Promise(()=>{}):Response.json(real.samples[1].floor));
 await assert.rejects(withDeadline(signal=>c.details(latest,()=>!signal.aborted,signal,rows=>{latest=rows;}),20));assert.equal(latest[0].floorVerified,true);assert.equal(latest[0].clientTypeAvailable,false);assert.equal(latest[0].priceLast,100);
});
test('old-scope browser completion cannot publish results',async()=>{
 let active=true,release,published=0;const gate=new Promise(r=>release=r);const c=createBrowserQuoteClient(async()=>{await gate;return Response.json(real.samples[1].floor);});const pending=c.details([base()],()=>active,undefined,()=>published++);active=false;release();await pending;assert.equal(published,0);
});
test('coverage and empty messages distinguish unavailable, partial and true zero-result',()=>{
 const r=base(),coverage=highlightCoverage([r],178);assert.equal(coverage.unreceived,177);assert.equal(coverage.realValues,0);assert.match(emptyDataMessage('money',0,178),/قابل تعیین نیست/);assert.match(emptyDataMessage('floor',5,178),/ناقص/);assert.match(emptyDataMessage('money',178,178),/دیده نشد/);
});
test('absent volume/value do not count as verified zero, but explicit zero does',()=>{
 const source={Symbol:'الف',Date:day,PriceLast:100,PriceYesterday:100};
 assert.equal(highlightCoverage([marketHighlightFromInstrument(source)],1).volume,0);
 assert.equal(highlightCoverage([marketHighlightFromInstrument({...source,Volume:0,Value:0})],1).volume,1);
 assert.equal(highlightCoverage([marketHighlightFromInstrument(source)],1).value,0);
});
test('batch expiry accounts for every unstarted symbol instead of labelling it missing upstream',async()=>{
 const batches=Array.from({length:18},(_,i)=>Array.from({length:i===17?8:10},(_,j)=>String(i*10+j)));
 const r=await loadBatches(batches,async()=>new Promise(()=>{}),{budgetMs:15,attemptMs:100,retryMs:1});assert.equal(r.expired,true);assert.equal(r.results.length,18);assert.equal(r.results.flatMap(x=>x.batch).length,178);assert.ok(r.results.every(x=>x.data===null&&x.error));
});
test('80 successful ranking rows plus 98 budget-limited symbols remain separate outcomes',async()=>{
 const batches=Array.from({length:18},(_,i)=>Array.from({length:i===17?8:10},(_,j)=>String(i*10+j)));let calls=0;
 const r=await loadBatches(batches,async batch=>++calls<=8?batch:new Promise(()=>{}),{budgetMs:25,attemptMs:100});
 assert.equal(r.results.flatMap(x=>x.data??[]).length,80);assert.equal(r.results.filter(x=>x.error).flatMap(x=>x.batch).length,98);assert.equal(r.expired,true);
});
test('browser detail outage probes later rows sparingly instead of permanently suppressing the provider',async()=>{
 let calls=0;const c=createBrowserQuoteClient(async()=>{calls++;return new Response('unavailable',{status:503});});
 const rows=Array.from({length:178},(_,i)=>({...base(),insCode:String(i)}));assert.equal((await c.details(rows)).length,178);assert.ok(calls<=130,calls);assert.ok(calls>24,calls);
});
