# Calc mouse input correction: browser evidence

The local follow-up build `2026.1014.1807` passes the four previously failing return-to-cell sequences and two additional click-mode checks. Six cases passed; case E stopped before editing because native toolbars appeared late and moved the target cell. The complete run remains `ok: false` and `matrixCompleted: false`. These results describe a local build labelled `0.5.0`. At the time of this validation, it was not a released installer, and the separate `0.5.0` release candidate was still blocked by its macOS freeze-pane check.

The [binary change and provenance](../vendor/patches/office-mouse-time.md) identify a native mouse callback that converts epoch milliseconds directly to an unsigned 32-bit timestamp. Its original range guard sends contemporary epoch values to zero. The bounded correction converts through unsigned 64 bits before retaining the existing 32-bit event field. The global date import stays unchanged. This is a deterministic transformation of the pinned runtime, with its source-equivalent change documented separately.

The browser test streamed the actual WASM response from the production preview and matched its bytes against the built asset: **161,667,500 bytes**, SHA-256 `56a2f4f43d0c5dbe45937054833d1946383bd07f1017d359d0efe7f4c9d85dd0`. The [machine-readable results](calc-input-fix-results.json) preserve this fingerprint, source and test fingerprints, original failure reports, screenshots and exported workbook hashes.

Each scenario uses a fresh Chromium context at 1560 × 1000, DPR 1. B2 is located independently from its distinctive fill in a screenshot; actual pointer and keyboard input enters `314` and confirms that Enter advances to B3. Native state reads use the public read-only protocol. Only C and D explicitly call the canvas DOM `focus()` method. Normal UI downloads are inspected independently as ZIP/XML.

| Case | Operation after committing B2 = 314 | Original result | Patched result |
| --- | --- | --- | --- |
| A | Click B2 directly | Stayed at B3 | B2 selected; exported 314 |
| B | Ctrl+Home, then click B2 | Stayed at A1 | B2 selected; exported 314 |
| C | DOM canvas focus, then click B2 | Stayed at B3 | B2 selected; exported 314 |
| D | DOM canvas focus, Ctrl+Home, then click B2 | Stayed at A1 | B2 selected; exported 314 |
| E | Click A4, then B2 | Passed | Failed during initial layout, before typing or this sequence |
| F | Double-click the original B2 point, End, type 9, Enter | Additional regression case | Exported 3149 |
| G | Delayed single-click at the original B2 point, type 9, Enter | Additional regression case | Exported 9 |

F recorded two trusted mouse-down events **256.795 ms** apart and a trusted DOM double-click. G recorded a same-position mouse-down interval of **5167.790 ms**. Their distinct final values verify editing versus replacing the cell. The native double-click threshold was not independently measured; the test uses an empirical minimum gap of 1200 ms and records the actual interval. Both cases then pass Ctrl+Home and A4 → B2 selection. Every successful export preserves `A1=ORIGIN`, `A4=KEEP` and `C5=SHEET_SENTINEL`.

G also enters `=NOW()` in C2 using actual keyboard input in a UTC browser context. Independent Python ZIP/XML inspection finds formula `NOW()` and cached serial `46309.4255318866` in the workbook's 1900 date system. This converts to **2026-10-14 10:12:45.955002 UTC**, strictly between formula entry at **10:12:44.520** and download completion at **10:12:49.222**. It passes without using the check's five-second rounding allowance. Browser and host wall clocks also agree. This checks the current UTC date; it does not establish historical 1900 leap-day behavior or all timezones.

E retains an independent layout failure. Its [initial screenshot](../test-results/calc-input-followup/2026-10-14T10-08-27-086Z-559947/E-before-edit.png) has the native menu but lacks three toolbar rows, placing B2 at `(159, 382.5)`. The [final screenshot](../test-results/calc-input-followup/2026-10-14T10-08-27-086Z-559947/E-final.png) shows those toolbars and B2 at `(159, 497.5)`, 115 pixels lower. The earlier coordinate reaches the name box; the document remains at A1, revision 0, with no typed edit or export. A 1500 ms screenshot-marker stability window did not cover this late layout change. E was not retried or reclassified as passed.

A separate reviewer read all six exported packages, checked values, sentinels and fingerprints, and inspected input audits and screenshots. The reviewer independently confirmed the UTC serial conversion and E's toolbar movement. Immediate screenshots can precede native repaint; final screenshots, public native state and exported content support the successful selection assertions. The raw report and prior failures remain unchanged.

This run establishes the exercised Calc input behavior. It does not repeat Word, narrow viewport or DPR 2 coverage, reopen the exports through the UI, or test timestamp wrap boundaries and system-clock adjustments. The outstanding initial-layout issue prevents a seven-case success claim.

Run the prepared matrix against a rebuilt production preview with:

```sh
CALC_INPUT_SCENARIOS=A,B,C,D,E,F,G node tests/browser/calc-input-focus.cjs
```

The [patched run report](../test-results/calc-input-followup/2026-10-14T10-08-27-086Z-559947/matrix-report.json) and [original causal summary](../test-results/calc-input-followup/2026-10-14T09-46-28-079Z-556182/causal-summary.json) remain separate evidence records.

The subsequent [first-frame investigation](calc-first-frame-investigation.md) records eight unsuccessful isolated readiness experiments, including the independently reviewed ResizeObserver failure. It does not change this run's historical results.
