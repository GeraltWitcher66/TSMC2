"use client";

import { useEffect, useState } from "react";
import { ownershipPresentation, type OwnershipValidation } from "./lib/holder-records";

/** Generic copy control; `kind` labels what the value is (نماد، گروه، …). */
export function CopyText({ value, kind }: { value: string; kind: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!message) return;
    // A transient clipboard notification must not permanently obscure rows.
    const timeout = window.setTimeout(() => setMessage(""), 1800);
    return () => window.clearTimeout(timeout);
  }, [message]);
  return <span className="symbol-copy-control">
    <button type="button" className="symbol-copy-button" aria-label={`کپی ${kind} ${value}`} title={`کپی ${kind} ${value}`} disabled={busy} onClick={async (event) => {
      event.stopPropagation(); setBusy(true); setMessage("");
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(value);
        setMessage(`${kind} ${value} کپی شد.`);
      } catch { setMessage("کپی انجام نشد؛ دسترسی کلیپ‌بورد مرورگر را بررسی کنید."); }
      finally { setBusy(false); }
    }}><span aria-hidden="true">⧉</span></button>
    <span className="copy-feedback" role="status">{message}</span>
  </span>;
}

export function CopySymbol({ symbol }: { symbol: string }) {
  return <CopyText value={symbol} kind="نماد" />;
}

export function OwnershipValue({ row }: { row: { ownershipPct: number | null; ownership?: OwnershipValidation } }) {
  const value = ownershipPresentation(row);
  return <span className={value.label === "نامعتبر" ? "ownership-invalid" : "ownership-value"} title={value.explanation}>
    <b>{value.label ?? `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(value.value!)}٪`}</b>
    {value.label === "نامعتبر" && <small>اطلاعات کل سهام ناسازگار است.</small>}
  </span>;
}
