"use client";
import { useEffect, useRef } from "react";
import type { ScreenerRow } from "./lib/market";
import type { DayOverDayDivergence } from "./lib/divergence";

const faN = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 });
const faRsi = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });
const date = (value: string | number | null | undefined) => {
  if (!value) return "—";
  const s = String(value);
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`));
};

function SessionCard({ title, dateValue, price, rsi, rsiDate, basis }: { title: string; dateValue: number | null; price: number; rsi: number; rsiDate: number; basis: "high" | "low" }) {
  return <div className="div-session-card">
    <strong>{title}</strong>
    <dl>
      <div><dt>تاریخ:</dt><dd><b>{date(dateValue)}</b></dd></div>
      <div><dt>{basis === "low" ? "کف قیمت" : "سقف قیمت"}:</dt><dd><b dir="ltr">{faN.format(price)}</b> <span className="unit">ریال</span></dd></div>
      <div><dt>RSI ۱۲ پایانی:</dt><dd><b dir="ltr">{faRsi.format(rsi)}</b>{rsiDate !== dateValue && <small> ({date(rsiDate)})</small>}</dd></div>
    </dl>
  </div>;
}

function SwingComparison({ div }: { div: DayOverDayDivergence }) {
  const priceUp = div.latest.price > div.previous.price;
  const rsiUp = div.latest.rsi > div.previous.rsi;
  return <figure className="divergence-chart">
    <svg viewBox="0 0 520 154" role="img" aria-label={`مقایسه شماتیک دو پیوت: ${div.label}، حرکت قیمت ${priceUp ? "صعودی" : "نزولی"}، حرکت RSI ${rsiUp ? "صعودی" : "نزولی"}`}>
      <line x1="18" y1="76" x2="502" y2="76" className="chart-grid" />
      <text x="18" y="15">PRICE</text>
      <text x="18" y="92">RSI 12</text>
      <path d={`M 126 ${priceUp ? 61 : 25} L 402 ${priceUp ? 25 : 61}`} fill="none" stroke="#2b7088" strokeWidth="3.5" strokeLinecap="round" />
      <path d={`M 126 ${rsiUp ? 137 : 100} L 402 ${rsiUp ? 100 : 137}`} fill="none" stroke="#be7b34" strokeWidth="3.5" strokeLinecap="round" />
      {[126, 402].map((x, i) => <g key={x}>
        <circle cx={x} cy={(i === 0) === priceUp ? 61 : 25} r="5" fill="#2b7088" />
        <circle cx={x} cy={(i === 0) === rsiUp ? 137 : 100} r="5" fill="#be7b34" />
      </g>)}
    </svg>
    <figcaption>مقایسه جهت دو پیوت؛ خطوط صرفاً شماتیک‌اند و نمودار کامل تاریخچه قیمت نیستند. مقادیر دقیق و تاریخ‌ها در کارت‌های بالا ثبت شده‌اند.</figcaption>
  </figure>;
}

export default function DivergenceDetails({ row, onClose }: { row: ScreenerRow; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const analysis = row.divergenceAnalysis;
  const div = analysis?.divergence ?? null;
  const closeLabel = analysis
    ? analysis.status === "insufficient" ? "داده کافی نیست"
      : analysis.status === "stale" ? "داده قدیمی است"
        : analysis.status === "unverified" ? "واگرایی به دلیل ناقص بودن مبنای آخرین معامله قابل تأیید نیست"
        : analysis.status === "adjustment" ? "در انتظار تأیید افزایش سرمایه"
          : analysis.status === "invalid" ? "داده نامعتبر"
            : analysis.status === "none" ? "بدون واگرایی"
              : null
    : "جزئیات تحلیل موجود نیست؛ اطلاعات نماد را بروزرسانی کنید.";
  return <dialog ref={dialog} className="divergence-dialog" aria-labelledby="divergence-title" onCancel={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-head"><div><p className="eyebrow">پیوت‌های تأییدشده · سقف و کف روزانه · RSI ۱۲ قیمت پایانی</p><h2 id="divergence-title">تحلیل واگرایی {row.symbol}</h2></div><button className="icon-button" type="button" aria-label="بستن تحلیل واگرایی" onClick={onClose}>×</button></div>
    <p className="divergence-explanation">{closeLabel ?? analysis?.reason ?? "—"}</p>
    {div && <>
      <div className="div-sessions">
        <SessionCard title="پیوت اول" dateValue={div.previous.date} price={div.previous.price} rsi={div.previous.rsi} rsiDate={div.previous.rsiDate} basis={div.priceBasis} />
        <SessionCard title="پیوت دوم" dateValue={div.latest.date} price={div.latest.price} rsi={div.latest.rsi} rsiDate={div.latest.rsiDate} basis={div.priceBasis} />
      </div>
      <SwingComparison div={div} />
      <div className="div-compare">
        <div className="div-compare-row"><span>{div.priceBasis === "low" ? "کف‌ها:" : "سقف‌ها:"}</span><b dir="ltr">{faN.format(div.previous.price)} → {faN.format(div.latest.price)} {div.priceDirection === "up" ? "↑" : "↓"}</b></div>
        <div className="div-compare-row"><span>RSI:</span><b dir="ltr">{faRsi.format(div.previous.rsi)} → {faRsi.format(div.latest.rsi)} {div.rsiDirection === "up" ? "↑" : "↓"}</b></div>
        <div className="div-compare-row"><span>تأیید پیوت:</span><b>{date(div.confirmationDate)}</b></div>
        <div className="div-compare-row"><span>فاصله:</span><b>{div.barsSincePivot} جلسه معاملاتی از پیوت دوم</b></div>
        <p className={`div-result ${div.kind === "positive" ? "positive" : "negative"}`}>نتیجه: {div.label}</p>
      </div>
    </>}
    <details className="divergence-rules" open={!div}>
      <summary>روش محاسبه</summary>
      <p>مبنای واگرایی، مقایسه <b>دو پیوت قیمت</b> در کندل‌های روزانه بسته‌شده و کف/سقف RSI نزدیک به همان تاریخ‌هاست؛ پیوت با دو کندل در هر سمت و فاصله حداقل پنج جلسه تأیید می‌شود. قیمت‌ها و RSI از داده تعدیل‌شده محاسبه می‌شوند.</p>
      <p><b>RD+ معمولی مثبت:</b> کف دوم قیمت پایین‌تر، کف RSI بالاتر. <b>RD− معمولی منفی:</b> سقف قیمت بالاتر، سقف RSI پایین‌تر.</p>
      <p><b>HD+ مخفی مثبت:</b> کف قیمت بالاتر و کف RSI پایین‌تر در روند صعودی. <b>HD− مخفی منفی:</b> سقف قیمت پایین‌تر و سقف RSI بالاتر در روند نزولی.</p>
      <p><b>تفکیک دو RSI:</b> ستون RSI جدول بر مبنای آخرین معامله حفظ شده؛ RSI مورد استفاده برای واگرایی از قیمت پایانی همان بازه محاسبه می‌شود. MACD در این نسخه محاسبه و تأیید نشده است. نبود پیوت یا تأیید روند یعنی هشدار صادر نمی‌شود؛ هیچ واگرایی تضمین خرید یا فروش نیست.</p>
    </details>
  </dialog>;
}
