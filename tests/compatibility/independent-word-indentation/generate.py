#!/usr/bin/env python3
"""Generate an unmodified native LibreOffice paragraph-indentation corpus.

The shared generator writes project-authored ODT files and converts them with
native LibreOffice. No DOCX ZIP entry or XML property is rewritten afterwards.
"""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
spec = spec_from_file_location("word_corpus", ROOT.parent / "independent-word" / "generate.py")
corpus = module_from_spec(spec)
spec.loader.exec_module(corpus)

corpus.STYLES = corpus.STYLES.replace(" </office:styles>", '''
  <style:style style:name="Indented" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="36pt" fo:margin-right="18pt" fo:text-indent="0pt"/></style:style>
  <style:style style:name="FirstLine" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="0pt" fo:margin-right="0pt" fo:text-indent="18pt"/></style:style>
  <style:style style:name="Hanging" style:family="paragraph" style:parent-style-name="Indented"><style:paragraph-properties fo:text-indent="-18pt"/></style:style>
  <style:style style:name="IndentedHeading" style:family="paragraph" style:parent-style-name="Heading_20_1" style:next-style-name="Indented" style:default-outline-level="1"><style:paragraph-properties fo:margin-left="24pt" fo:margin-right="12pt" fo:text-indent="12pt"/></style:style>
 </office:styles>''')

corpus.CASES = [{
    "name": "paragraph-indentation",
    "purpose": "Named inherited left/right, first-line and hanging indents, explicit zero resets, and an indented heading with a differently indented follow style.",
    "automaticStyles": '''<style:style style:name="ZeroReset" style:family="paragraph" style:parent-style-name="Hanging"><style:paragraph-properties fo:margin-left="0pt" fo:margin-right="0pt" fo:text-indent="0pt"/></style:style>''',
    "body": '''<text:p text:style-name="Standard">Plain baseline paragraph.</text:p><text:p text:style-name="Indented">Inherited left and right indentation. 中文段落。</text:p><text:p text:style-name="FirstLine">First line indentation only. This sentence is deliberately long enough to wrap when the document is viewed at a narrow width.</text:p><text:p text:style-name="Hanging">Hanging indentation. The first line starts before subsequent lines, with the left and right paragraph margins retained.</text:p><text:p text:style-name="ZeroReset">Explicit zero cancels inherited indentation.</text:p><text:h text:style-name="IndentedHeading" text:outline-level="1">Indented heading</text:h><text:p text:style-name="Standard">Final plain paragraph.</text:p>''',
    "paragraphs": ["Plain baseline paragraph.", "Inherited left and right indentation. 中文段落。", "First line indentation only. This sentence is deliberately long enough to wrap when the document is viewed at a narrow width.", "Hanging indentation. The first line starts before subsequent lines, with the left and right paragraph margins retained.", "Explicit zero cancels inherited indentation.", "Indented heading", "Final plain paragraph."],
    "expectedSemantics": {"indentPoints": [
        {"left": 0, "right": 0, "firstLine": 0},
        {"left": 36, "right": 18, "firstLine": 0},
        {"left": 0, "right": 0, "firstLine": 18},
        {"left": 36, "right": 18, "firstLine": -18},
        {"left": 0, "right": 0, "firstLine": 0},
        {"left": 24, "right": 12, "firstLine": 12},
        {"left": 0, "right": 0, "firstLine": 0}
    ], "zeroResetParagraph": 4, "headingParagraph": 5, "headingFollowIndentPoints": {"left": 36, "right": 18, "firstLine": 0}},
}]

if __name__ == "__main__":
    if "--output" not in sys.argv:
        sys.argv.extend(["--output", str(ROOT)])
    corpus.main()
