import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {calculatePeriod,isSellQueueToPositive} from '../app/lib/market.ts';
const base=process.env.QA_BASE_URL||'http://127.0.0.1:3119',out=process.env.QA_OUTPUT;
if(!out||!process.env.QA_CAPTURE)throw Error('QA_OUTPUT and QA_CAPTURE are required');
await mkdir(out,{recursive:true});
const captures=JSON.parse(await readFile(process.env.QA_CAPTURE,'utf8'));
const captured=captures.find(x=>x.path==='market-highlights').data;
const holder=captures.find(x=>x.path==='holder-increases').data;
const checks=[],errors=[],check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 for(const width of [1366,390]){
  const context=await browser.newContext({viewport:{width,height:900}});
  const symbols=captured.rows.map(r=>r.symbol);
  await context.addInitScript(s=>localStorage.setItem('ss-haghighi-v1',JSON.stringify(s)),symbols);
  let upstreamCalls=0,fullHolderCalls=0;
  await context.route('**/api/**',async route=>{
   const u=new URL(route.request().url()),body=route.request().method()==='POST'?route.request().postDataJSON():{};
   if(!u.href.startsWith(base)){if(/ClosingPrice|ClientType|GetStaticThreshold/.test(u.pathname))upstreamCalls++;return route.fulfill({status:503,json:{error:'Controlled external failure during replay'}});}
   if(u.pathname==='/api/screener'){
    const candles=[{d_even:20261007,close:100,high:104},{d_even:20260901,close:90,high:95}];
    return route.fulfill({json:{rows:symbols.map(symbol=>({symbol,status:'ready',three:calculatePeriod(candles,90),six:calculatePeriod(candles,180),actions:[]})),latestDate:20261007}});
   }
   if(u.pathname==='/api/holder-increases'){
    if(!body.instruments)fullHolderCalls++;
    return route.fulfill({json:body.instruments?{summaries:{},sourceDate:20261007,partial:true}:holder});
   }
   if(u.pathname==='/api/market-highlights')return route.fulfill({json:captured});
   return route.fulfill({status:503,json:{error:'Controlled unused route'}});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('.session-state').getByText(/۱۴۰۵/).waitFor();
  await page.getByRole('button',{name:'ورود به برنامه',exact:true}).click();
  check(width+' no automatic shareholder scan',fullHolderCalls===0);
  await page.getByRole('button',{name:/بیشترین‌های فهرست/}).click();
  await page.locator('.session-date-badge b').filter({hasText:'۱۴۰۵'}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.highlights-loading'));
  check(width+' ClientType warning correctly absent',!await page.getByText('قیمت‌ها دریافت شد، اما جزئیات حجم خرید و فروش حقیقی موقتاً از منبع رسمی در دسترس نبود.',{exact:true}).isVisible());
  check(width+' floor warning correctly absent',!await page.getByText('کف مجاز همان روز برای بعضی نمادها تأیید نشد؛ آن‌ها وارد فیلتر بازگشت از کف مجاز نمی‌شوند.',{exact:true}).isVisible());
  check(width+' verified details not fetched again',upstreamCalls===0);
  const money=page.locator('.highlight-card').nth(2);
  const expected=captured.rows.filter(r=>(r.netRealValue??0)>0).sort((a,b)=>b.netRealValue-a.netRealValue);
  check(width+' real-money card has exact positive source symbols',JSON.stringify(await money.locator('tbody .symbol-date-line strong').allInnerTexts())===JSON.stringify(expected.map(r=>r.symbol)));
  const compact=new Intl.NumberFormat('fa-IR',{notation:'compact',maximumFractionDigits:1});
  for(const row of expected)check(width+' raw buy-minus-sell reaches money card '+row.symbol,(await money.innerText()).includes(compact.format(row.netRealValue)));
  check(width+' real sample reversal inclusion matches existing criteria',await page.locator('.reversal-date').count()===captured.rows.filter(isSellQueueToPositive).length);
  check(width+' same source date shown',(await page.locator('.session-date-badge').innerText()).includes('۱۴۰۵/۰۷/۱۵'));
  check(width+' four reversal columns',await page.locator('.reversal-table-head > *').count()===4);
  check(width+' RTL has no page overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:out+'/real-replay-'+width+'.png',fullPage:true});
  await context.close();
 }
 check('no browser exceptions',errors.length===0);
}finally{
 await writeFile(out+'/phase2-browser.json',JSON.stringify({checks,errors,scope:'Real local workerd responses replayed in UI; separate existing synthetic regression gate tests failures and historical warnings'},null,2));
 await browser.close();
}
console.log('PASS '+checks.length+' phase2 captured-real browser assertions');
