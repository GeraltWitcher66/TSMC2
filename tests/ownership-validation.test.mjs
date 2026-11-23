import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOwnership, enrichHolding, historicalOwnership, ownershipPresentation, bindInstrumentInfo } from '../app/lib/holder-records.ts';
import { holderFreshnessText } from '../app/lib/holder-freshness.ts';
import { groupHolderRowsBySymbol } from '../app/lib/format.ts';
import { loadVerifiedHolderSnapshot } from '../app/data/holder-snapshot.ts';
import { createBrowserMarketClient } from '../app/lib/browser-market.ts';

const candidate = { id:'controlled', insCode:'QA', instrumentName:'داده مصنوعی', shareholderType:'شخص حقیقی', currentShares:125, previousShares:120, changeShares:5, changeEvidence:'snapshot', date:20260907 };
const info = { lVal18AFC:'آزمون', flowTitle:'بورس', zTitad:100, requestedInsCode:'QA', metadataSource:'controlled-test' };
for(const [current,total,value,status] of [
 [125,100,null,'invalid'],[100,100,100,'unverified'],[0,100,0,'unverified'],[1,300,0.333,'unverified'],[125,10000,1.25,'unverified'],
 [17000000,1200000000,1.417,'unverified'],[100,0,null,'unavailable'],[100,null,null,'unavailable'],[100,undefined,null,'unavailable'],
 [-10,100,null,'invalid'],[100,-100,null,'invalid'],[NaN,100,null,'invalid'],[Infinity,100,null,'invalid'],[100,Infinity,null,'invalid'],
 [Number.MAX_SAFE_INTEGER+1,Number.MAX_SAFE_INTEGER+2,null,'invalid'],[100.1,200,null,'invalid'],
])test(`ownership ${String(current)}/${String(total)} -> ${value} (${status})`,()=>{
 const row=enrichHolding({...candidate,currentShares:current},{...info,zTitad:total});
 assert.equal(row.ownershipPct,value); assert.equal(row.ownership.status,status);
 assert.ok(Object.is(row.currentShares,current));assert.equal(row.changeShares,5);
 assert.equal(JSON.parse(JSON.stringify(row)).ownership.currentShares,Number.isFinite(current)?current:String(current));
});

test('strict numeric parsing never accepts boolean, exponent, separators, blanks or wrong units',()=>{
 for(const total of [true,{},'1,000','1e3','  '])assert.equal(validateOwnership(candidate,{...info,zTitad:total}).ownershipPct,null);
 assert.equal(validateOwnership(candidate,{...info,zTitad:'10000'}).ownershipPct,1.25);
 assert.equal(validateOwnership(candidate,{...info,zTitad:10000,totalSharesUnit:'millions'}).ownership.reason,'unit_mismatch');
});
test('unknown capital date is explicit, matching provenance validates, mismatch quarantines percent only',()=>{
 const validInfo={...info,zTitad:10000,totalSharesEffectiveDate:20260907};
 assert.equal(enrichHolding(candidate,validInfo).ownership.status,'valid');
 const unknown=enrichHolding(candidate,{...validInfo,totalSharesEffectiveDate:undefined});
 assert.equal(unknown.ownership.status,'unverified');assert.equal(unknown.ownership.totalSharesEffectiveDate,null);
 const mismatch=enrichHolding(candidate,{...validInfo,totalSharesEffectiveDate:20260908});
 assert.equal(mismatch.ownershipPct,null);assert.equal(mismatch.ownership.reason,'date_mismatch');assert.equal(mismatch.currentShares,125);
 assert.equal(validateOwnership({...candidate,date:20260231},{...validInfo,totalSharesEffectiveDate:20260231}).ownership.reason,'date_mismatch');
});
test('instrument mismatch cannot supply another denominator; binding does not invent capital date',()=>{
 assert.throws(()=>bindInstrumentInfo({...info,insCode:'OTHER'},'QA'),/شناسه/);
 const bound=bindInstrumentInfo({...info,insCode:'QA'},'QA');assert.equal(bound.totalSharesEffectiveDate,undefined);
 assert.equal(validateOwnership(candidate,{...info,zTitad:10000,insCode:'OTHER'}).ownership.reason,'instrument_mismatch');
});
test('invalid ownership remains invalid in largest-holder parent and its preserved child',()=>{
 const invalid=enrichHolding(candidate,info),valid=enrichHolding({...candidate,id:'second',currentShares:90,changeShares:10},info);
 const g=groupHolderRowsBySymbol([invalid,valid])[0];assert.equal(g.people,2);assert.equal(g.maxChange,10);
 assert.equal(g.representative.id,invalid.id);assert.equal(ownershipPresentation(g.representative).label,'نامعتبر');
 assert.equal(ownershipPresentation(g.children.find(r=>r.id===invalid.id)).value,null);
 assert.equal(ownershipPresentation(valid).value,90);
});
test('historical snapshot is not mutated, valid values preserved, reported impossible value quarantined',async()=>{
 const snapshot=await loadVerifiedHolderSnapshot();const before=JSON.stringify(snapshot);
 for(const row of snapshot.rows){const result=historicalOwnership(row);assert.equal(result.ownershipPct,row.ownershipPct);assert.equal(result.ownership.status,'unverified');assert.equal(result.ownership.totalShares,null);}
 assert.equal(JSON.stringify(snapshot),before);
 const bad=historicalOwnership({...snapshot.rows[0],ownershipPct:125});assert.equal(bad.ownershipPct,null);assert.equal(bad.ownership.reason,'reported_invalid');
 assert.equal(bad.ownership.reportedPercent,125);
 assert.equal(ownershipPresentation({ownershipPct:Infinity}).label,'نامعتبر');
});
test('freshness separates source, cache, bundled, partial and unavailable without redating',()=>{
 const source={sourceDate:20260907,delivery:'source'};
 assert.match(holderFreshnessText(source,20260907),/دریافت‌شده از منبع/);
 assert.match(holderFreshnessText({...source,delivery:'cache'},20261007),/ذخیره‌شده قبلی/);
 const text=holderFreshnessText({...source,delivery:'bundled',fallback:true,partial:true,servedAt:'2026-10-08'},20261007);
 assert.match(text,/۱۴۰۵\/۰۶\/۱۶/);assert.match(text,/جلسه مورد انتظار امروز نیست/);assert.match(text,/اتصال زنده.*تأیید نمی‌شود/);assert.match(text,/ناقص/);
 assert.doesNotMatch(text,/۱۴۰۵\/۰۷\/۱۶/);assert.match(holderFreshnessText(null),/تأیید نشده/);
});

let version=0;
const routeModule=()=>import(`../app/api/holder-increases/route.ts?ownership=${++version}`);
const changes={dates:[20260906,20260907],shareHoldersChanges:[{name:'شخص حقیقی',insList:[{insCode:'QA',firstDay:120,secondDay:125}]}]};
test('API serialization retains invalid raw amounts/reason and distinguishes cached source receipt',async t=>{
 t.mock.method(globalThis,'fetch',async url=>Response.json(String(url).includes('GetShareHolderChanges')?changes:{instrumentInfo:{...info,insCode:'QA'}}));
 const {GET}=await routeModule();const request=()=>new Request('http://localhost/api/holder-increases');
 const a=await (await GET(request())).json(),b=await (await GET(request())).json();
 assert.equal(a.rows[0].ownershipPct,null);assert.equal(a.rows[0].ownership.reason,'exceeds_total');assert.equal(a.rows[0].currentShares,125);assert.equal(a.rows[0].ownership.totalShares,100);
 assert.equal(a.delivery,'source');assert.equal(b.delivery,'cache');assert.equal(a.fetchedAt,b.fetchedAt);assert.equal(a.sourceDate,b.sourceDate);assert.equal(a.fallback,false);
});
for(const status of [403,500])test(`provider ${status} keeps dated bundled records and explicit provenance`,async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('<html>blocked</html>',{status}));
 const {GET}=await routeModule();const response=await GET(new Request('http://localhost/api/holder-increases'));const data=await response.json();
 assert.equal(response.status,200);assert.equal(data.fallback,true);assert.equal(data.delivery,'bundled');assert.equal(data.sourceDate,20260907);assert.ok(data.rows.length>0);
 assert.equal(data.rows[0].ownership.reason,'historical_unverified');assert.match(data.warning,new RegExp(String(status)));
});
test('browser provider shares same invalid ownership and cache semantics',async()=>{
 const client=createBrowserMarketClient(async url=>Response.json(String(url).includes('GetShareHolderChanges')?changes:{instrumentInfo:{...info,insCode:'QA'}}));
 const a=await client.holders(),b=await client.holders();assert.equal(a.rows[0].ownershipPct,null);assert.equal(a.rows[0].ownership.reason,'exceeds_total');assert.equal(a.delivery,'source');assert.equal(b.delivery,'cache');assert.equal(a.fetchedAt,b.fetchedAt);
});
