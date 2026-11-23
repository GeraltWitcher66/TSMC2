# QA Report — Divergence v3 (day-over-day) + Shareholder Grouping + Readability

**Deployment:** Worker version `d56de5fb-6989-4af8-a363-ef7d5e6dc1fb`
**Production URL:** https://iran-stock-screener.ar-nikzad09.workers.dev — HTTP 200 ✓
**Date:** 2026-09-15 (۱۴۰۵/۰۶/۲۴)

## Scope
Complete replacement of the pivot/swing divergence engine with the client's
day-over-day specification (latest closed trading session vs previous closed
trading session, close direction vs RSI(12) direction), shareholder vertical
grouping, M/B RTL-safe formatting, and date/percentage readability fixes.

## Automated validation (exact commands)

| Check | Command | Result |
|---|---|---|
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` | 0 errors |
| ESLint (app) | `node node_modules/eslint/bin/eslint.js app` | 0 errors, 1 pre-existing warning (`_lookbackDays` kept for call-compatibility) |
| Production build | `node node_modules/vite/bin/vite.js build` | success (64 modules) |
| Full test suite | `node --import ./tests/register-typescript.mjs --test tests/*.test.mjs` | **89/89 pass** |

## Test suite composition (current spec only)
- `tests/divergence-daily.test.mjs` — 17 tests: client cases A–J (negative
  example, positive example, same-direction = none, unchanged price/RSI = none,
  Friday/holiday gap uses previous trading session, open candle excluded before
  13:00 Tehran, insufficient history, JSON round trip) plus invalid/stale/
  adjustment data-quality states.
- `tests/adjustment-matching.test.mjs` — 11 tests: unresolved extreme gaps never
  contaminate RSI; official share-change matching (45-day cap, closest date
  wins); artifact/listing/halt affirmative evidences.
- `tests/market-math.test.mjs` — 34 tests including real-market snapshot
  regression under the new contract.
- Old pivot-divergence tests (`divergence-v2`, `divergence-dataflow`) were
  **deleted** — the obsolete specification is no longer tested anywhere.

## Live-market evidence (674 symbols, sessions 20260912–20260914)
Tally: `none:570, negative:72, positive:8, stale:12, insufficient:5, adjustment:6`

Negative (price↑ & RSI12↓):
| Symbol | Prev session | Latest session | Rule check |
|---|---|---|---|
| پارسان | 20260912 close=35210 rsi=78.11 | 20260913 close=35570 rsi=69.51 | 35570>35210 ✓, 69.51<78.11 ✓ |
| وبصادر | 1011 / 70.82 | 1037 / 69.69 | ✓ |
| شپنا | 14250 / 79.33 | 14500 / 77.86 | ✓ |

Positive (price↓ & RSI12↑):
| Symbol | Prev session | Latest session | Rule check |
|---|---|---|---|
| آبادا | 20260912 close=11230 rsi=61.89 | 20260913 close=11220 rsi=62.23 | 11220<11230 ✓, 62.23>61.89 ✓ |
| فروسیل | 20260913 close=16000 rsi=84.41 | 20260914 close=15640 rsi=85.14 | ✓ |
| وهامون | 1710 / 73.48 | 1687 / 74.01 | ✓ |

## Production verification (after deploy)
- Main page: HTTP 200, Persian app shell found.
- Old pivot wording («تشکیل الگو», «شکست سطح تأیید», «سقف/کف اول») absent from served HTML.
- `/api/screener` (POST, 20 symbols): rows=20, statuses `{none:19, negative:1}`;
  sample آردینه — previous 20260913 close=35910 rsi=72.86 → latest 20260914
  close=36440 rsi=71.85, label «واگرایی منفی», version `3`, lossless shape.
- `/api/holder-increases` (POST view=rows): فجام returns TWO separate person
  records (current 17,000,000 / 14,949,250; ownershipPct 1.417 / 1.246 — percent
  scale sane; date 20260907; evidence snapshot).

## Browser QA (local preview of the built bundle)
- Screener table: 178 rows rendered; divergence column shows «واگرایی منفی» /
  «واگرایی مثبت» / «بدون واگرایی» labels from the new engine.
- Details modal (آردینه): two session cards (روز قبل ۱۴۰۵/۰۶/۲۲ · ۳۵٬۹۱۰ ریال ·
  RSI ۷۲٫۹ / آخرین روز ۱۴۰۵/۰۶/۲۳ · ۳۶٬۴۴۰ ریال · RSI ۷۱٫۸), comparison lines
  «قیمت: ۳۵٬۹۱۰ → ۳۶٬۴۴۰ ↑ / RSI: ۷۲٫۹ → ۷۱٫۸ ↓», result «نتیجه: واگرایی منفی»,
  Persian explanation sentence — exactly per spec.
- Highlights card: «تاریخ داده: ۱۴۰۵/۰۶/۲۳» badge (real source date); holder
  groups render one parent per symbol with «۲ شخص حقیقی» badge and vertically
  separated child rows (شخص حقیقی ۱ / ۲) showing current shares (33M/32M),
  signed change (+1.4M/+1M), ownership (۱٫۷۴٪/۱٫۶۸٪) and bold dates.
- M/B numbers computed with `direction: ltr; unicode-bidi: isolate` — verified
  computed styles on rendered cells.
- No text element below 10px in sampled cells/rows (previously 7–8px).
- Mobile viewport 440×880: table scrolls horizontally instead of compressing
  text; summary grid single-column; mode switch usable.
- 1366/1920 desktop: verified via DOM metrics (previous session's compact
  table CSS retained; no min-width regressions introduced).

## Known limitation
- The desktop-app preview webview again produced no frames, so PNG screenshots
  could not be captured in-session (all visual checks above were DOM/computed-
  style based). Same limitation documented in prior QA rounds.

## Remaining risks
- Positive divergences are rare on strongly up-trending sessions (8 of 674 on
  the sampled days) — mathematically expected, not a defect.
- 55→6 adjustment-blocked symbols reduced after real upstream shares fixes;
  blocked symbols still show «در انتظار تأیید افزایش سرمایه» by design.
- RSI basis is the last-trade series (`last`) while price direction uses
  قیمت پایانی (`close`); this is required for the client's examples to be
  reachable and matches other TSETMC screeners' behavior.
