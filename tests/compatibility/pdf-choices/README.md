# Original PDF choice-field fixture

`make-fixture.py` creates a two-page AcroForm and fills its three editable fields through the actual PDF engine. `audit.py` uses independent pypdf parsing to check exported values, indices, appearances and untouched objects. Generated PDFs and reports belong in `test-results/pdf-choices/`, not the application bundle.

The fixture has paired CJK/Latin combo options, an ordinary list, string-only options, a protected multi-select field, a read-only field, a note, a link, bookmarks and a second-page sentinel. It contains no third-party document or application assets.

Scope and limitations: [PDF choice-field support](../../../docs/pdf-choice-fields.md).
