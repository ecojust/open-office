# Localization parity with PowerPoint

> **Last reviewed:** 2026-10-15 · **Last updated:** 2026-10-15 · **Change:** minor (Open Office embedded Simplified Chinese interface catalog; WASM/browser validation recorded; standalone language coverage and parity scores not re-measured) · **Target:** Microsoft PowerPoint for Mac 16.113 (Microsoft 365)

Standalone OfficePresentation's interface remains English, with no language switch. This vendored copy
adds a Simplified Chinese display catalog for the Open Office embedded editor, described below;
it does not enable Chinese in standalone windows. Requests: #15 (follow the system language),
#30 and PR #34 (Ukrainian, open). Dimension score: **~8% ready** (the existing estimate: English
complete, slide-text script support partly there), **55–90 h** to parity plus native-speaker
review. The embedded work has not been used to increase these scores or reduce the estimates.

## Open Office embedded interface

The local integration implements Simplified Chinese labels at the `ui-egui` display boundary,
using the catalogs under `crates/ui-egui/src/i18n/`. The embedded host enables the language for
an editor frame or command, and the previous language is restored afterwards. Standalone
OfficePresentation retains English; system-language detection and a general language setting remain open.

Implemented coverage includes ribbon tabs and controls, menus and tooltips, editing dialogs,
format and navigation panes, workspace status and operation messages, slide-show controls and
presenter view. Built-in shape, WordArt warp, animation and transition, SmartArt, chart and
table, picture-style and artistic-effect, recolor, sound and icon labels are included, along with
composed effect options. Chart names and animation directions receive contextual labels.

Translations apply to interface text. Document content, user-entered names, file paths, command
IDs and serialized values retain their original values; unknown display strings fall back to
their original text. This is a local Open Office implementation, not a claim that upstream has
shipped a Chinese interface or that every display string has been verified.

The release WASM build, browser navigation and editing/export checks pass for this local change.
Screenshots cover all ten main ribbons, one contextual ribbon, eight panes and seventeen dialogs.
Renderer regressions keep translated empty prompts out of exports and preserve custom prompts.
Native desktop verification, native-speaker review and a fresh UI-string coverage measurement
remain open; full upstream CI stopped at an uncached dependency in offline metadata resolution.
The standalone table and parity estimates below therefore retain their previous values. Local
integration details and validation results belong in
[the Open Office integration notes](../../../docs/office-presentation-integration.md).

## How the numbers are measured

- **UI strings:** ~1,050 user-visible string literals (measured 2026-10-10: distinct
  capitalized literals in `crates/ui-egui/src`, `crates/engine/src/cmd` and `crates/model/src`,
  including the 226 command labels). This is the earlier standalone baseline, not a measurement
  of the new embedded catalog; the percentages below remain against this figure until re-measured.
- **Script support** is about slide text (what users type and import), separately from the UI:
  bidi and shaping live in `crates/text` (UAX #9, HarfRust, UAX #14 line breaking).
- **PowerPoint's languages:** `Contents/Resources/*.lproj` in PowerPoint 16.113.4: ar, cs, da, de,
  el, en, en_GB, es, es_MX, fi, fr, fr_CA, he, hu, id, it, ja, ko, nl, no, pl, pt (Brazil), pt_PT,
  ru, sk, sv, th, tr, zh_CN, zh_TW (26 languages). PowerPoint for **Mac** has no Hindi or Vietnamese
  UI; PowerPoint for Windows has both.

## The twelve key languages

This table describes standalone OfficePresentation. The embedded Chinese implementation above is tracked
separately and has no measured translation-coverage percentage yet.

| Language | Code | UI strings translated | Dialogs / tooltips / help | Script support (slide text) | Native review | Status | PowerPoint for Mac UI | Hours to full |
|---|---|---|---|---|---|---|---|---|
| English | en | ~1,050 / ~1,050 (100%) | yes / yes / no help | full | yes | **full** | yes | 0 |
| Simplified Chinese (Mandarin) | zh-Hans | 0 (0%) | no | renders with system CJK fonts (asset policy excludes Noto CJK from builds); UAX #14 breaking; IME composition (#101); no true vertical layout | no | none | yes | 6–10 (incl. IME) |
| Spanish | es | 0 (0%) | no | full (Latin) | no | none | yes (es, es-MX) | 3–5 |
| Hindi | hi | 0 (0%) | no | Devanagari shaping through HarfRust, untested; no bundled Devanagari font | no | none | **no** (Windows only) | 4–7 |
| Arabic | ar | 0 (0%) | no | bidi, contextual shaping, kashida justification, RTL bullets and caret (#4); **UI not mirrored**; browser export shows boxes (#81) | no | none | yes | 10–16 (incl. UI mirroring) |
| French | fr | 0 (0%) | no | full (Latin) | no | none | yes (fr, fr-CA) | 3–5 |
| Portuguese | pt | 0 (0%) | no | full (Latin) | no | none | yes (pt-BR, pt-PT) | 3–5 |
| Indonesian | id | 0 (0%) | no | full (Latin) | no | none | yes | 3–5 |
| Japanese | ja | 0 (0%) | no | renders with system or craft-fonts Japanese faces; IME composition (#101); vertical text is rotated, not laid out vertically | no | none | yes | 4–7 |
| German | de | 0 (0%) | no | full (Latin) | no | none | yes | 3–5 |
| Korean | ko | 0 (0%) | no | system Hangul fonts, in the interface too; IME composition (#101) | no | none | yes | 4–7 |
| Vietnamese | vi | 0 (0%) | no | stacked diacritics through HarfRust | no | none | **no** (Windows only) | 3–5 |

Other languages shipped: **0** (Ukrainian is in review as PR #34). PowerPoint for Mac ships 16 more
than the twelve above: Czech, Danish, Greek, Finnish, Hebrew, Hungarian, Italian, Dutch, Norwegian,
Polish, Russian, Slovak, Swedish, Thai, Turkish and Traditional Chinese.

Per-language hours assume the infrastructure exists: **8–14 h** once for a string catalog (copy a
sibling app's approach, e.g. EffectCraft's menu and panel catalogs), a language setting that follows
the system (#15), plural and number formatting, and an `xtask` check that every key has a
translation. IME composition landed with #101 (slide text, table cells, notes and text fields;
one undo step per composition, underlined in place); the hours that included it are kept until
the next re-measure.

## Proofing languages

PowerPoint checks spelling in dozens of languages and lets each run carry a proofing language.
OfficePresentation keeps `a:rPr/@lang` on round trip but its spelling check is a small English list of
common misspellings (`crates/engine/src/cmd/review.rs`); see [gaps.md](gaps.md#proofing-spelling-thesaurus-autocorrect).

## Revision history

| Date | Change | Summary |
|---|---|---|
| 2026-10-15 | minor | Open Office embedded Simplified Chinese display catalogs cover editor controls, dialogs, panes, galleries and presentation controls; standalone remains English; WASM/browser validation recorded; native desktop verification and coverage measurement remain open, scores unchanged |
| 2026-10-14 | minor | IME composition in a table cell is underlined in place; the candidate window sits on that cell's caret |
| 2026-10-12 | minor | IME composition for Chinese, Japanese and Korean, and interface text in any installed script (#101) |
| 2026-10-10 | major | Created: twelve-language table, ~1,050 UI strings measured, PowerPoint for Mac's 26 languages from its bundle |
