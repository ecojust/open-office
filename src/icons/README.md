# Open Office interface icons

These SVG drawings are original Open Office artwork, distributed under the
[project MIT license](../../LICENSE). They were drawn for the application's
interface; they do not reproduce the upstream editors' icon paths or use a
third-party icon pack.

The `svg/shell`, `svg/word`, `svg/sheet`, `svg/deck`, and `svg/pdf` directories contain the editable
sources. The design uses a 24 × 24 grid, rounded strokes, open space around each
shape, and restrained accent details. Letterforms in editing symbols are paths,
so they do not depend on the user's fonts. The main stroke inherits the interface
foreground; accent details follow the host theme.

`scripts/build-office-icons.mjs` validates the supported SVG subset and compiles
Word, spreadsheet, and presentation artwork to static vector geometry. The canvas renderers use
that geometry directly; no network fetch or per-frame SVG parsing is needed.
PDF uses the same original SVG sources through its image loader, with a generated embedding table.
The application build checks these sources together with each editor's generated
output. Files named `office_icons.rs` are generated; edit their SVG sources.

This artwork concerns application controls. Pictures, shapes, and icon artwork
already inserted into a user's document are separate document content.
