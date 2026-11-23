import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {loadVerifiedHolderSnapshot} from '../app/data/holder-snapshot.ts';
import {enrichHolding,historicalOwnership} from '../app/lib/holder-records.ts';
import {calculatePeriod,calculateValuationMetrics,marketHighlightFromInstrument} from '../app/lib/market.ts';
import {groupHolderRowsBySymbol,compactSharesEn,signedSharesEn} from '../app/lib/format.ts';
const out=process.env.QA_OUTPUT;if(!out)throw new Error('QA_OUTPUT outside source is required');await mkdir(out,{recursive:true});
const base=process.env.QA_BASE_URL||'http://127.0.0.1:3112';
const snapshot=await loadVerifiedHolderSnapshot();
const historical=snapshot.rows.filter(r=>['خکاوه','فنر','فجام'].includes(r.symbol)).map(historicalOwnership);
const invalid=enrichHolding({...historical[0],id:'SYNTHETIC-INVALID',insCode:'QA',instrumentName:'آزمون مصنوعی درصد',currentShares:125,previousShares:120,changeShares:5},{lVal18AFC:'آزمون درصد',flowTitle:'بورس',zTitad:100,requestedInsCode:'QA'});
const rows=[...historical,invalid],symbols=[...new Set(rows.map(r=>r.symbol))];
const candles=[{d_even:20260907,close:100,high:120},{d_even:20260801,close:90,high:140},{d_even:20260601,close:80,high:110}];
const screener=symbol=>({symbol,insCode:'qa-'+symbol,status:'ready',actions:[],rsi:40,realHolders:null,three:calculatePeriod(candles,90),six:calculatePeriod(candles,180),valuation:calculateValuationMetrics(100,10,6.5,9.25)});
const checks=[],errors=[];const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
for(const [width,height] of [[1366,768],[1920,1080],[390,844],[430,932]].filter(([w])=>!process.env.QA_WIDTH||w===Number(process.env.QA_WIDTH))){
 const context=await browser.newContext({viewport:{width,height},hasTouch:width<500,permissions:['clipboard-read','clipboard-write']});
 await context.addInitScript(({symbols})=>{localStorage.setItem('ss-haghighi-v1',JSON.stringify(symbols));localStorage.setItem('ss-custom-v1',JSON.stringify(['فجام']));},{symbols});
 let mode='success';const calls=[];
 await context.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());if(!req.url().startsWith(base)){await route.fulfill({status:503,body:'QA external unavailable'});return;}
  const body=req.method()==='POST'?req.postDataJSON():{};calls.push({path:url.pathname,body});
  if(url.pathname==='/api/screener'){
   if(mode==='hang')return;
   if(mode==='error'){await route.fulfill({status:500,json:{error:'خطای کنترل‌شده'}});return;}
   await route.fulfill({json:{rows:body.symbols.map(screener),latestDate:20260907}});
  }else if(url.pathname==='/api/holder-increases')await route.fulfill({json:body.instruments?{summaries:{},sourceDate:20260907,fallback:true,delivery:'bundled'}:{...snapshot,rows,delivery:'bundled',fallback:true,nextCursor:null}});
  else if(url.pathname==='/api/market-highlights')await route.fulfill({json:{rows:body.symbols.map(symbol=>marketHighlightFromInstrument({Symbol:symbol,Date:20260907,AllowedMinDate:20260907,PriceYesterday:1000,PriceLast:1020,PriceClose:970,PriceMin:970,AllowedMin:970,Volume:1e7,Value:1e10,NetRealValue:2e7})),latestDate:20260907}});
  else if(url.pathname==='/api/holders')await route.fulfill({json:{counts:Object.fromEntries(body.symbols.map(s=>[s,2]))}});
  else await route.fulfill({status:503,json:{error:'QA external unavailable'}});
 });
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('.session-state').getByText(/۱۴۰۵/).waitFor();await page.getByRole('button',{name:'ورود به برنامه',exact:true}).click();await page.getByRole('button',{name:'ورود به برنامه',exact:true}).waitFor({state:'hidden'});
 check(`${width} original teal palette restored`,await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--navy-950').trim()==='#0c2431'));
 await page.getByRole('button',{name:/بروزرسانی اطلاعات/}).waitFor();
 check(`${width} no auto scan`,!calls.some(c=>c.path==='/api/holders'||(c.path==='/api/holder-increases'&&!c.body.instruments)));
 const pairs=await page.locator('tbody tr').first().locator('.pe-pair-item').allInnerTexts();check(`${width} P/E labels`,pairs[0].includes('۶٫۵')&&pairs[1].includes('۹٫۲۵'));
 await page.getByRole('button',{name:/فیلتر ۱۸۰ روزه/}).click();check(`${width} 180`,await page.locator('tbody tr').count()===4);await page.getByRole('button',{name:/فیلتر ۹۰ روزه/}).click();
 await page.getByRole('searchbox',{name:'جستجو در نمادها',exact:true}).fill('فنر');await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1);check(`${width} search`,(await page.locator('tbody').innerText()).includes('فنر'));await page.getByRole('searchbox',{name:'جستجو در نمادها',exact:true}).fill('');await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===4);
 const sorter=page.locator('thead button').first();await sorter.click();const order=await page.locator('tbody .symbol-cell strong').allInnerTexts();await sorter.click();check(`${width} sorting`,JSON.stringify(order)===JSON.stringify((await page.locator('tbody .symbol-cell strong').allInnerTexts()).reverse()));
 await page.locator('.star-button').first().click();await page.getByRole('button',{name:/نمادهای منتخب/}).click();check(`${width} favorites`,await page.locator('tbody tr').count()===1);
 await page.getByRole('button',{name:/فیلتر ۹۰ روزه/}).click();await page.locator('.source-chip').nth(2).click();await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1);check(`${width} custom watchlist`,(await page.locator('tbody').innerText()).includes('فجام'));await page.locator('.source-chip').first().click();
 await page.getByRole('button',{name:'خ خرید حقیقی عمده',exact:true}).click();await page.locator('.holder-group-row').first().waitFor();
 check(`${width} all groups collapsed`,await page.locator('.holder-child-row').count()===0);
 check(`${width} historical warning/date visible`,(await page.locator('.holder-freshness').innerText()).includes('۱۴۰۵/۰۶/۱۶')&&(await page.locator('.holder-freshness').innerText()).includes('امروز نیست'));
 async function copy(button,symbol,keyboard=false){
  await page.evaluate(()=>navigator.clipboard.writeText('sentinel'));
  if(keyboard){await button.focus();await page.keyboard.press('Enter');}else if(width<500)await button.tap();else await button.click();
  await button.locator('..').getByRole('status').getByText(`نماد ${symbol} کپی شد.`,{exact:true}).waitFor();
  check(`${width} exact clipboard ${symbol}`,await page.evaluate(()=>navigator.clipboard.readText())===symbol);
 }
 for(const group of groupHolderRowsBySymbol(rows)){
  const parent=page.locator('.holder-group-row').filter({has:page.getByRole('button',{name:new RegExp(`^${group.symbol}`)})});
  const toggle=parent.locator('button[aria-expanded]');const before=(await parent.locator('td').allInnerTexts()).slice(2);
  check(`${width} ${group.symbol} numerical parent`,before[0].includes(compactSharesEn(group.representative.currentShares))&&before[2].includes(signedSharesEn(group.representative.changeShares)));
  await copy(parent.getByRole('button',{name:`کپی نماد ${group.symbol}`,exact:true}),group.symbol,group.people===1);
  if(width===1366&&group.symbol===symbols[0]){
   await parent.locator('.copy-feedback').getByText(/کپی شد/).waitFor({state:'hidden',timeout:4500});
   check('copy popup auto-dismisses',await parent.locator('.copy-feedback').innerText()==='');
  }
  check(`${width} copy does not expand ${group.symbol}`,await toggle.getAttribute('aria-expanded')==='false');
  await page.evaluate(()=>navigator.clipboard.writeText('expand sentinel'));await toggle.locator('.holder-people-inline').click();
  check(`${width} expand does not copy ${group.symbol}`,await page.evaluate(()=>navigator.clipboard.readText())==='expand sentinel');
  check(`${width} child count ${group.symbol}`,await page.locator('.holder-child-row').count()===group.people);
  check(`${width} parent stable ${group.symbol}`,JSON.stringify(before)===JSON.stringify((await parent.locator('td').allInnerTexts()).slice(2)));
  if(group.symbol==='آزمون درصد')check(`${width} invalid parent and child, current retained`,(await parent.innerText()).includes('نامعتبر')&&(await page.locator('.holder-child-row').innerText()).includes('نامعتبر')&&!(await page.locator('tbody').innerText()).includes('۱۲۵٪'));
  else check(`${width} valid ownership unchanged ${group.symbol}`,(await parent.locator('td').nth(3).innerText()).includes(new Intl.NumberFormat('fa-IR',{maximumFractionDigits:2}).format(group.representative.ownershipPct)));
  await toggle.focus();await page.keyboard.press('Space');check(`${width} keyboard collapse`,await toggle.getAttribute('aria-expanded')==='false');
 }
 await page.screenshot({path:`${out}/holders-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:/بیشترین‌های فهرست/}).click();await page.locator('.holder-group-head').first().waitFor();
 check(`${width} card groups collapsed`,await page.locator('.holder-person-row').count()===0);
 for(const symbol of ['خکاوه','فنر','آزمون درصد']){
  const parent=page.locator('.holder-group-head').filter({has:page.getByRole('button',{name:new RegExp(`^${symbol}`)})});await copy(parent.getByRole('button',{name:`کپی نماد ${symbol}`,exact:true}),symbol);
  check(`${width} card copy does not expand`,await parent.locator('button[aria-expanded]').getAttribute('aria-expanded')==='false');await parent.locator('button[aria-expanded]').click();
  if(symbol==='آزمون درصد')check(`${width} card invalid child`,(await page.locator('.holder-person-row').innerText()).includes('نامعتبر'));
  await parent.locator('button[aria-expanded]').click();
 }
 await copy(page.locator('.highlight-card').first().getByRole('button',{name:'کپی نماد خکاوه',exact:true}),'خکاوه');
 await copy(page.locator('.reversal-highlight-card').getByRole('button',{name:'کپی نماد خکاوه',exact:true}),'خکاوه');
 check(`${width} reversal four columns`,await page.locator('.reversal-table-head > *').count()===4);
 check(`${width} all card dates`,await page.locator('.reversal-date').count()===4&&await page.locator('.highlight-card').nth(2).locator('.row-date').count()>0);
 check(`${width} card fallback warning`,(await page.locator('.holder-freshness').innerText()).includes('پشتیبان تاریخی'));
 check(`${width} no nested buttons`,await page.locator('button button').count()===0);
 check(`${width} no page/card overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)&&await page.locator('.holder-groups').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.screenshot({path:`${out}/cards-${width}.png`,fullPage:true});
 // Permission failure is an explicit UI outcome, not a claimed clipboard success.
 await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new DOMException('denied','NotAllowedError');};});
 const denied=page.locator('.reversal-highlight-card').getByRole('button',{name:'کپی نماد خکاوه',exact:true});await denied.click();await denied.locator('..').getByRole('status').getByText(/کپی انجام نشد/).waitFor();check(`${width} clipboard denial visible`,true);
 await page.getByRole('button',{name:/فیلتر ۹۰ روزه/}).click();mode='error';await page.getByRole('button',{name:/بروزرسانی اطلاعات/}).click();await page.getByRole('alert').waitFor();check(`${width} failed refresh retains original date`,(await page.locator('.session-state').innerText()).includes('۱۴۰۵/۰۶/۱۶'));
 if(width===1366){mode='hang';await page.clock.install();await page.getByRole('button',{name:/بروزرسانی اطلاعات/}).click();await page.clock.fastForward(55001);await page.clock.fastForward(701);await page.clock.fastForward(65001);await page.getByRole('button',{name:/بروزرسانی اطلاعات/}).waitFor();check('hang terminates within simulated budget',await page.getByRole('alert').count()>0);}
 await context.close();
}
check('no browser page errors',errors.length===0);
}finally{for(const context of browser.contexts())for(const page of context.pages()){await page.screenshot({path:`${out}/interrupted-browser.png`,fullPage:true}).catch(()=>{});await writeFile(`${out}/interrupted-dom.txt`,await page.locator('body').innerText().catch(()=>''));}await writeFile(`${out}/remediation-browser.json`,JSON.stringify({checks,errors,provenance:'Snapshot 20260907, synthetic invalid ownership and price/valuation fixtures; financial API requests intercepted'},null,2));await browser.close();}
console.log(`PASS ${checks.length} actual browser assertions; live market parity not tested`);
