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

Common toolbar icons use an 18 px viewport; large ribbon actions use 28 px.
Compact status indicators and dropdown arrows keep smaller viewports so the
hierarchy remains clear. Product accent colors distinguish the document types;
the same action keeps the same drawing in every workspace.

`scripts/build-office-icons.mjs` validates the supported SVG subset and compiles
Word, spreadsheet, and presentation artwork to static vector geometry. The canvas renderers use
that geometry directly; no network fetch or per-frame SVG parsing is needed.
PDF uses the same original SVG sources through its image loader, with a generated embedding table.
Its foreground and accent paints are colored separately before rasterization,
so a muted foreground cannot darken the accent. Theme variants reuse cached SVG
bytes; the cache has a fixed entry limit.
The application build checks these sources together with each editor's generated
output. Files named `office_icons.rs` are generated; edit their SVG sources.

`shared.json` records equivalent artwork among editor families and the shell;
the build rejects differences between these sources. `shell-aliases.json`
lets shell and notebook controls directly reuse editor SVGs. The generator
creates `shell-aliases.ts` with only those explicit imports, and checks that an
alias cannot shadow a shell SVG or point to another alias.

This artwork concerns application controls. Pictures, shapes, and icon artwork
already inserted into a user's document are separate document content.
