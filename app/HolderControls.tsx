"use client";

import { useEffect, useState } from "react";
import { ownershipPresentation, type OwnershipValidation } from "./lib/holder-records";

export function CopySymbol({ symbol }: { symbol: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!message) return;
    // A transient clipboard notification must not permanently obscure rows.
    const timeout = window.setTimeout(() => setMessage(""), 1800);
    return () => window.clearTimeout(timeout);
  }, [message]);
  return <span className="symbol-copy-control">
    <button type="button" className="symbol-copy-button" aria-label={`کپی نماد ${symbol}`} title={`کپی نماد ${symbol}`} disabled={busy} onClick={async (event) => {
      event.stopPropagation(); setBusy(true); setMessage("");
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(symbol);
        setMessage(`نماد ${symbol} کپی شد.`);
      } catch { setMessage("کپی انجام نشد؛ دسترسی کلیپ‌بورد مرورگر را بررسی کنید."); }
      finally { setBusy(false); }
    }}><span aria-hidden="true">⧉</span></button>
    <span className="copy-feedback" role="status">{message}</span>
  </span>;
}

export function OwnershipValue({ row }: { row: { ownershipPct: number | null; ownership?: OwnershipValidation } }) {
  const value = ownershipPresentation(row);
  return <span className={value.label === "نامعتبر" ? "ownership-invalid" : "ownership-value"} title={value.explanation}>
    <b>{value.label ?? `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(value.value!)}٪`}</b>
    {value.label === "نامعتبر" && <small>اطلاعات کل سهام ناسازگار است.</small>}
  </span>;
}
