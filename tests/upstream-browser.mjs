import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { calculatePeriod, marketHighlightFromInstrument } from '../app/lib/market.ts';
const base=process.env.QA_BASE_URL||'http://127.0.0.1:3119',out=process.env.QA_OUTPUT;
if(!out||!process.env.QA_CAPTURE)throw Error('QA_OUTPUT and QA_CAPTURE are required');
await mkdir(out,{recursive:true});
const captured=JSON.parse(await readFile(process.env.QA_CAPTURE,'utf8')).find(x=>x.path==='market-highlights').data;
const messages=['تاریخ منبع نامشخص','قیمت‌ها دریافت شد، اما جزئیات حجم خرید و فروش حقیقی موقتاً از منبع رسمی در دسترس نبود.','تاریخ قیمت بعضی نمادها در منبع قابل تأیید نیست؛ زمان بروزرسانی به معنی تاریخ معامله نیست.','کف مجاز همان روز برای بعضی نمادها تأیید نشد؛ آن‌ها وارد فیلتر بازگشت از کف مجاز نمی‌شوند.'];
const checks=[],errors=[];const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 for(const mode of ['unknown','captured-real-response','complete-synthetic']){
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  const symbols=mode==='captured-real-response'?captured.rows.map(r=>r.symbol):['آزمون'];
  await context.addInitScript(symbols=>localStorage.setItem('ss-haghighi-v1',JSON.stringify(symbols)),symbols);
  await context.route('**/api/**',async route=>{
   const u=new URL(route.request().url());
   if(!u.href.startsWith(base))return route.fulfill({status:503,json:{error:'controlled external failure'}});
   if(u.pathname==='/api/screener'){
    const candles=[{d_even:20261007,close:100,high:104},{d_even:20260901,close:90,high:95}];
    return route.fulfill({json:{rows:symbols.map(symbol=>({symbol,status:'ready',three:calculatePeriod(candles,90),six:calculatePeriod(candles,180),actions:[]})),latestDate:20261007}});
   }
   if(u.pathname==='/api/holder-increases')return route.fulfill({json:{summaries:{},sourceDate:20260907,fallback:true,delivery:'bundled'}});
   if(u.pathname==='/api/market-highlights'){
    if(mode==='captured-real-response')return route.fulfill({json:captured});
    const complete=mode==='complete-synthetic';
    const row=marketHighlightFromInstrument({Symbol:'آزمون',InsCode:'qa',Date:complete?20261007:0,AllowedMinDate:complete?20261007:0,AllowedMin:95,PriceYesterday:100,PriceLast:103,PriceClose:98,PriceMin:95,Volume:1000,Value:98000},complete?{buy_I_Volume:600,sell_I_Volume:400}:null);
    return route.fulfill({json:{rows:[row],latestDate:row.sessionDate,clientTypeUnavailable:!complete,partial:!complete}});
   }
   return route.fulfill({status:503,json:{error:'controlled external failure'}});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('.session-state').getByText(/۱۴۰۵/).waitFor();await page.getByRole('button',{name:'ورود به برنامه',exact:true}).click();
  await page.getByRole('button',{name:/بیشترین‌های فهرست/}).click();
  await page.locator('.highlights-intro-line').waitFor();
  await page.getByText('فقط نمادهای فهرست خودمان',{exact:true}).waitFor();
  // Wait for the actual ranking request and bounded browser enrichment to settle.
  await page.waitForFunction(()=>!document.querySelector('.highlights-loading')&&document.querySelectorAll('.session-date-badge b').length>0);
  await page.locator('.session-date-badge b').filter({hasText:mode==='unknown'?'تاریخ منبع نامشخص':'۱۴۰۵'}).waitFor();
  for(let i=0;i<messages.length;i++){
   const visible=await page.getByText(messages[i],{exact:i!==0}).isVisible();
   check(`${mode}: warning ${i+1}`,visible===(mode==='unknown'||(mode==='captured-real-response'&&(i===1||i===3))));
  }
  check(`${mode}: own-watchlist ranking preserved`,await page.getByText('فقط نمادهای فهرست خودمان',{exact:true}).isVisible());
  await page.screenshot({path:`${out}/${mode}.png`,fullPage:true});await context.close();
 }
 check('no browser exceptions',errors.length===0);
 await writeFile(`${out}/warnings.json`,JSON.stringify({checks,errors,scope:'Captured real response replay and explicit synthetic controls; not fresh upstream requests'},null,2));
 console.log(`PASS ${checks.length} warning/browser assertions`);
}finally{await browser.close();}
