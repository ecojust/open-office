# Header / footer preservation fixture

`rich-decorations.docx` is an internally generated blank Writer document whose header and footer OOXML were replaced with a small deterministic example: red bold label, blue italic `Page `, a real PAGE field, green external `https://example.com/help` hyperlink, and purple trailing text. It has no executable attachments, macro or external image. The URL is metadata and is not fetched by these tests.

This fixture tests plain-run edits and refusal of edits crossing fields, links, or character-format boundaries. Expected behavior is asserted against actual native export baselines, not only the fixture's original serialization.
