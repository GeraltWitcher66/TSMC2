# Divergence Acceptance Report — Version 829a4a73-36f9-48bc-a97d-946a84c2466e

## Final fix — the unresolved-gap discriminator (closed the "silently passes" hole)

**Previous rule was unsafe:** an extreme gap with no official data, no calendar break and a close >12% from the new reference stayed outside the corporate-action path — exactly the shape of a genuine overnight capital increase missing its official record. **New rule: UNKNOWN EXTREME DISCONTINUITY ⇒ DO NOT CONTAMINATE RSI.** An extreme reference gap (ratio <0.60 / >1.50) now blocks as `unresolved` (status `adjustment`, RSI withheld) unless ONE affirmative evidence applies:

1. **Official share-change record** matches within 45 days and ±15% ratio deviation → applied (ground truth, regardless of calendar shape);
2. **Fresh listing** — the gap candle is the FIRST candle of the feed (no prior scale to corrupt, no adjustment definable);
3. **Halt restart** — ≥10 calendar days AND the resume candle carries NO reference price (new scale stands alone);
4. **Continuous close series** — |close[i]/close[i−1]−1| ≤ 0.16 (two consecutive limit moves ≈1.05×1.10). RSI runs on closes only, so a broken `yesterday` field next to continuous closes mathematically cannot contaminate the oscillator — the Zarvan provider-artifact shape.

Calendar shape and close-vs-reference proximity are explicitly NOT evidence.

**Real-market consequence:** کالا without its official record now correctly returns `adjustment` (was: silently analyzable); with the official 29B→62B record it applies the adjustment. All six previously accepted acceptance symbols are unchanged.

**Regression results (tests/adjustment-matching.test.mjs + adjustment-guard.test.mjs, 19/19):**

| # | Case | Result |
|---|---|---|
| 1 | Genuine overnight action, no data, no break, close within 12% | BLOCKS (`adjustment`, RSI null) ✅ |
| 2 | Genuine overnight action, no data, no break, close >12% from reference | BLOCKS ✅ |
| 3 | Provider artifact (broken yesterday, continuous closes) | analyzable, no block ✅ |
| 4 | Fresh listing (first candle) | not classified ✅ |
| 5 | Halt/reopen without reference price | not classified ✅ |
| 6 | Ordinary extreme move, continuous close chain | analyzable ✅ |
| + | 90-day-old identical-ratio increase never matches a new gap | ✅ |
| + | Closest-date wins (two in-window increases) | ✅ |
| + | 46-day-old increase never consumed | ✅ |
| + | کالا shape applies inside 45 days with official data | ✅ |
| + | Long closure, continuous closes | analyzable ✅ |

**Full suite: 105/105 pass** · typecheck 0 errors · lint clean · build OK.
Pivot/divergence logic untouched — only `resolveAnalysisAdjustments` changed.

## Final checks (2) — matching safety + pivot-date separation

**Check 1 — corporate-action matching safety.** Matching window tightened from 180 days to **MAX_CHANGE_DISTANCE_DAYS = 45 days** (documented: registration precedes ex-rights by up to a couple of weeks; a change registered >45 days before a gap must already be reflected in prices). Closest registration date wins. New regression suite `tests/adjustment-matching.test.mjs` (6/6): 90-day-old identical-ratio increase does NOT match a new gap; closest of two in-window increases wins; 46-day-old identical ratio never consumed; کالا shape applies inside 45 days; no-data continuous-close blocks (never silently passes); no-data + close >12% from new reference: no-break stays outside the path, long-break blocks as adjustment.

**Check 2 — price vs RSI pivot dates** (bar distance, alignmentBars=2):

| Symbol | Price P1 | RSI P1 | dist | Price P2 | RSI P2 | dist | within window |
|---|---|---|---|---|---|---|---|
| پاکشو | 20260809 / 11060 | 20260808 / 82.88 | 1 | 20260831 / 12400 | 20260829 / 80.21 | 1 | YES |
| دارو | 20260726 / 6990 | 20260725 / 96.56 | 1 | 20260823 / 9400 | 20260822 / 92.39 | 1 | YES |
| دامین | 20260809 / 16190 | 20260808 / 84.89 | 1 | 20260823 / 17190 | 20260822 / 73.33 | 1 | YES |
| نمرینو | 20260809 / 9150 | 20260808 / 77.01 | 1 | 20260831 / 9600 | 20260829 / 72.48 | 1 | YES |
| تشتاد | 20260721 / 4400 | 20260720 / 36.32 | 1 | 20260802 / 4280 | 20260802 / 39.00 | 0 | YES |
| کیا | 20260628 / 7180 | 20260628 / 30.43 | 0 | 20260715 / 6950 | 20260714 / 34.18 | 1 | YES |

Full suite after both checks: **100/100 pass**. Redeployed: **e2a336ec-51a9-4943-a987-b68c81f48fb3**, production E2E re-verified after deploy (same five-class table as below).

**Date:** 2026-09-12 · **Scope:** divergence only (one guard fix + tests; no unrelated redesign)

## 1. Numeric pivot proof (engine on real upstream candles, limit=260)

Inequalities: bearish needs `P2>P1 AND RSI2<RSI1`; bullish needs `P2<P1 AND RSI2>RSI1`.

| Symbol | P1 Date | P1 Close | P1 RSI | P2 Date | P2 Close | P2 RSI | P2>P1 / P2<P1 | RSI2<RSI1 / RSI2>RSI1 | Type | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| پاکشو | 20260809 | 11060 | 82.8808 | 20260831 | 12400 | 80.2123 | 12400>11060 ✅ | 80.21<82.88 ✅ | bearish/detected | **PASS** |
| دارو | 20260726 | 6990 | 96.5557 | 20260823 | 9400 | 92.3918 | 9400>6990 ✅ | 92.39<96.56 ✅ | bearish/detected | **PASS** |
| دامین | 20260809 | 16190 | 84.8946 | 20260823 | 17190 | 73.3349 | 17190>16190 ✅ | 73.33<84.89 ✅ | bearish/confirmed | **PASS** |
| تشتاد | 20260721 | 4400 | 36.3150 | 20260802 | 4280 | 38.9981 | 4280<4400 ✅ | 39.00>36.32 ✅ | bullish/confirmed (now inactive) | **PASS** |
| کیا | 20260628 | 7180 | 30.4326 | 20260715 | 6950 | 34.1805 | 6950<7180 ✅ | 34.18>30.43 ✅ | bullish/confirmed (now inactive) | **PASS** |
| نمرینو | 20260809 | 9150 | 77.0102 | 20260831 | 9600 | 72.4836 | 9600>9150 ✅ | 72.48<77.01 ✅ | bearish/detected | **PASS** |

Note: price and RSI pivots are independent swing points; the engine reports the RSI pivot's own date (`startRsiDate`/`endRsiDate`, ≤ alignmentBars=3 candles from the price pivot). تشتاد and کیا later invalidated/confirmed — they are honest past events, shown with full data.

## 2. Client screenshot verification

All 8 screenshots re-OCR'd (tesseract + fas traineddata). The annotated divergence screenshot (`img_08_letters.png`) shows the client's complaint text **«واگرایی ها کار نمیکنه»** over the 90-day screener where every row reads **«واگرایی فعالی ندارد»** — no symbol/date in the screenshot identifies a *specific expected divergence*; the rows shown (آبین ۱۴۰۵/۰۶: RSI ۸۸٫۹ up-move, تموح, آکام, ابتکار) are all up-trending symbols where the correct answer IS "no active divergence". The client's complaint was that EVERYTHING showed nothing — which matches the root cause found (production data-flow erased all divergences), not a wrong algorithm.

| Screenshot evidence | Client expectation | Engine (before fix) | Engine (after fix) | Verdict |
|---|---|---|---|---|
| img_08: all rows "واگرایی فعالی ندارد" + text «واگرایی ها کار نمیکنه» | divergence column should work | every row null (data-flow bug) | 12 active events across 674 symbols; نماد rows now show real states | **PASS** (root cause = data-flow, fixed) |
| img_08 row آبین RSI≈۸۸ up-move | — | n/a | "no active divergence" is CORRECT for a fresh up-move with no matching RSI lower-high | correct behaviour |
| img_03/04: «کوچیک کنی که همه ستون‌ها…», «نمادهایی که یک اسم دارن کنار هم…» | layout/grouping (issues #5/#4) | — | fixed in earlier round (1080px table, grouped rows) | PASS (out of divergence scope) |

## 3. Detected vs confirmed semantics under `quoteVerified=false`

Regression tests (`tests/divergence-dataflow.test.mjs`, all pass):

- **unverified keeps the signal:** `recalculateScreenerRow(..., quoteVerified=false)` → `divergence.type='bullish'`, `state='confirmed'`, `status='warning'`, note explains freshness only. Signal is NOT deleted.
- **no forced promotion:** the state field is never written by the verification path; `confirmed` is set only by an actual closed-candle break of the confirmation level (`browser-quotes.test.mjs` covers neckline break semantics; `divergence-v2.test.mjs` asserts "a 1% rebound is NOT a neckline break").
- **detected stays distinct from confirmed:** fixture asserts `state='detected'` pre-break and `state='confirmed'` with `confirmationDate` after break — two separate tests per direction.
- **API = UI:** JSON round-trip test asserts all fields survive; live UI modal for نمرینو shows ۹٬۱۵۰/۹٬۶۰۰, RSI ۷۷٫۰۱/۷۲٫۴۸, confirm ۸٬۰۵۰, invalid ۹٬۶۰۰ — exactly the engine numbers.

## 4. Corporate-action / adjustment guard — exact NEW rule

An observed reference gap (`yesterday[i]/close[i-1]`) is corporate-action material only if `extreme`: ratio < 0.60 or > 1.50. Then:

1. **Official share data first (ground truth):** if a registered change matches within 180 days and ±15% relative deviation of the ratio (tolerance widened from 0.5% because Zarvan's `yesterday` is the prior day's weighted average, not the theoretical adjusted reference), the adjustment is APPLIED — regardless of calendar shape. *Proven on the real کالا case: gap 0.445 on 20260607 (exactly 7 days break, close broken 36%), official 29B→62B record → applied, analysis unblocked.*
2. **No official data:** the gap blocks as `unresolved` (→ `adjustment` status) only if the traded close CONTINUES the new reference chain (`|close/yesterday−1| ≤ 12%`) — that is what a real ex-rights session looks like, and silently accepting it would fabricate a price crash. Otherwise (broken chain + no ≥8-day calendar break) it is outside the corporate-action path entirely: fresh listings, halt reopens and provider artifacts pass through without false blocks.

Guard tests: `tests/adjustment-guard.test.mjs` — 8/8 pass, covering genuine capital increase without a break, the same gap without official data, continuous-close resolution, unresolved blocking, provider artifact, ordinary strong move, extreme erroneous ratio, long closure without corporate action.

## 5. End-to-end production proof (engine → API, five classes)

| Class | Symbol | Engine (raw candles) | Production API | Match |
|---|---|---|---|---|
| bearish-active | پاکشو | active bearish/detected, P1 11060/82.88, P2 12400/80.21 | identical pivot numbers, `divergence=bearish/detected` | ✅ |
| bullish-past | کیا | past bullish/confirmed, P1 7180/30.43, P2 6950/34.18 | identical pivot numbers in `divergenceAnalysis.events[0]` | ✅ |
| none | آبین | none | none (correct: RSI 88.9 fresh up-move) | ✅ |
| insufficient | اتکاسا | insufficient (<100 candles) | same status in note | ✅ |
| adjustment | بنیرو | adjustment (unresolved increase) | same status in note | ✅ |

RSI differences (65.5 engine vs 68.8 API for پاکشو) come from the API merging the newest session candle; the divergence object and pivots are bit-identical.

**UI (live browser):** نمرینو row = «دارای واگرایی · منفی · تشکیل الگو»; modal evidence block matches engine values exactly (see §3).

## 6. Final acceptance table

Combined from §1 and §5 — every case PASS.

## Validation

- `tsc --noEmit`: 0 errors · `vite build`: OK · **94/94 tests pass** (`node --import ./tests/register-typescript.mjs --test tests/*.test.mjs`)
- Deployed: **d6a3f19d-835a-4a71-9aef-b13f7583d628** → production re-verified with the same E2E probe after deploy.
