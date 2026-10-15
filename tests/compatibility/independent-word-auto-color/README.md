# Automatic foreground color: fixed native evidence

Reference: LibreOfficeDev 26.8.0.0.alpha0, commit `2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`.

This corpus retains six complete authored DOCX packages with 61 paragraphs and 30 untouched native outputs (first DOCX, ODT, PDF, second DOCX and its PDF). Seven additional keyboard controls retain their complete authored DOCX and 21 native edited DOCX/ODT/PDF outputs, action scripts, Java UNO driver and logs. No editor parser or renderer generated the native expectations. No Microsoft Word runtime was used.

## Verified contract

`w:color w:val="auto"` is a distinct automatic foreground value. Preserve it in the document model and exports; do not replace it with explicit black. Omitted color inherits an ancestor; with no ancestor color the native default is automatic. Explicit RGB remains distinct even when it currently paints the same color.

Automatic color overrides inherited RGB in document defaults, paragraph styles and their ancestry, explicitly referenced character styles and their ancestry, direct runs, and independent paragraph-marker formatting. An implicit default character style does not override a paragraph's color; explicit reference to that same style does. A marker's color does not recolor the existing runs. Empty marker and ordinary run properties remain separately observable in native XML.

On the ordinary white document canvas used by the editor, native PDF automatic foreground chooses black or white from character **shading**, with transparent/no shading falling back to white. Highlight is independent and does not participate in the foreground choice: black shading plus white highlight still gives white foreground, and white shading plus black highlight still gives black foreground. This can produce low contrast; it is the measured reference behavior, not a recommended color palette.

The fixed reference computes WCAG linear relative luminance from sRGB, scales by 255, truncates to an integer, and considers values at most 87 dark. One historical exception is exactly RGB `729FCF`, which uses its older integer brightness rule (at most 62). In this corpus `9E9E9E` paints white and `9F9F9F` black; `729FCF` paints black while neighboring `729FCE` and `729FD0` paint white. The checker validates these values against actual PDF text color operators, not against a product-generated screenshot.

Native keyboard controls use `XToolkitRobot` Enter followed by typing `x`, or typing into an empty paragraph. A named character color equal to its current paragraph color persists across Enter into a differently colored next style: this holds for both automatic and explicit red. An explicitly referenced default character style and direct automatic color also persist. Without either character style or direct color, the new text follows the next paragraph's red. Direct or named automatic color on an empty marker applies to typed text. These observations justify retaining the character color's provenance even when its current value equals the paragraph value.

## Reproduce frozen checks

With Python and PyMuPDF, from any working directory:

```sh
python /path/to/open-office/tests/compatibility/independent-word-auto-color/validate_native.py
```

`inspect_docx.py` independently resolves ZIP/XML style ancestry and source/direct declarations. `validate_native.py` opens every actual package and PDF, independently resolves ODT foreground, compares source and native semantics, first/second-save painting, native typing results and artifact hashes. `expected.json` retains the independently inspected XML and PDF observations; `manifest.json` gives portable paths and expectations for browser tests. `inventory.json` seals corpus bytes, checkers, metadata and documentation; `verification.json` records the check. Native outputs were not sanitized. Historical research command paths in metadata were replaced with portable placeholders.

## Fixed source anchors

`source-manifest.json` records exact source URLs and SHA-256 values. The source files themselves remain in the independent research directory; downloading them is optional for the portable check.

- [DomainMapper.cxx lines 2658–2672](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2658) passes the parsed color into `PROP_CHAR_COLOR`.
- [ThemeColorHandler.hxx lines 43–49](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/ThemeColorHandler.hxx#L43) records the raw color independently from theme attributes.
- [fntcache.cxx lines 2340–2440](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/fntcache.cxx#L2340) resolves automatic foreground from character shading, frame background and canvas, with screen/accessibility branches.
- [swfont.hxx lines 202–204](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/inc/swfont.hxx#L202) keeps character background and highlight as separate properties.
- [color.cxx lines 35–57](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/tools/source/generic/color.cxx#L35) defines the fixed revision's luminance threshold and historical exception; [color.hxx lines 274–277](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/include/tools/color.hxx#L274) defines the older brightness calculation.
- [docxattributeoutput.cxx lines 8246–8265](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8246) and [util.cxx lines 132–147](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/filter/source/msfilter/util.cxx#L132) serialize automatic as `auto` separately from RGB.

## Boundaries

This does not add themes, alpha foreground, custom application font colors, accessibility overrides, dark document canvases, paragraph/page/table backgrounds, or Microsoft Word compatibility claims. A separate research-only `w:background` black document still printed a white canvas with the reference's default settings; it does not establish dark-canvas support. Browser behavior is bounded to the supported white document canvas and RGB character shading.

ODT confirms automatic foreground semantics through `style:use-window-font-color`; its native serializer merges character highlight/shading into a single background in some cases. ODT background is therefore not a paint oracle for DOCX's separate highlight/shading layers. The native baseline is DOCX→PDF and reopened DOCX→PDF. Pixel-perfect layout, pagination and custom-font equivalence are not claimed.
