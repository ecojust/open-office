# Word list fixtures

These small DOCX packages were authored locally for compatibility testing. They
contain two independent numbered lists sharing one abstract numbering definition,
a nested item, an interrupted continuation and a bullet list. The target paragraphs
also include bold blue text, a hyperlink and a PAGE field. No external link is opened.

`independent-lists-start-override.docx` differs by the second numbered list's
start-only override of 7. The base source generator is `make-fixture.py`; its
manifest records the checked-in source's SHA-256. The independent package inspector
and before/after audit are `tests/browser/inspect-word-lists.py` and
`tests/browser/audit-word-lists.py`. Full research evidence is retained under
`open-office-research/onlyoffice/word-list-review`.

The browser UI test uses actual Find, list controls, Undo/Redo and native exports.
Independent package inspection compares exports against native baseline exports;
it does not require byte-identical ZIPs after the engine's own normalization.
