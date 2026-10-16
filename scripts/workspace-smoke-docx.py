#!/usr/bin/env python3
"""Independently inspect the small DOCX written by the native autosave smoke.

Reuse the bounded ZIP/OPC/XML parser, but do not require the separate rich-text
smoke's formatting. Only visible ordinary paragraph text is accepted here.
"""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location(
    "office_docx_oracle", Path(__file__).with_name("office-word-smoke-docx.py")
)
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
W = oracle.W


def inspect(path):
    document, _styles = oracle.package(path)
    oracle.require(document.tag == W + "document", "invalid document root")
    children = list(document)
    oracle.require(len(children) == 1 and children[0].tag == W + "body", "invalid document body")
    body = children[0]
    paragraphs = []
    for paragraph in body:
        if paragraph.tag == W + "sectPr":
            oracle.require(paragraph is body[-1], "unexpected section position")
            oracle.require(not list(paragraph.iter(W + "t")), "unexpected section text")
            continue
        oracle.require(paragraph.tag == W + "p", "unsupported non-paragraph content")
        oracle.container(paragraph)
        pieces = []
        for run in paragraph:
            if run.tag == W + "pPr":
                oracle.require(not list(run.iter(W + "t")), "unexpected paragraph property text")
                continue
            oracle.require(run.tag == W + "r", "unsupported or hidden paragraph content")
            oracle.container(run)
            for item in run:
                if item.tag == W + "rPr":
                    oracle.properties(item)  # Reject hidden text, fields, and unsupported formatting.
                    continue
                oracle.require(item.tag == W + "t", "unsupported non-text run content")
                oracle.require(not list(item), "unexpected child in text")
                pieces.append(item.text or "")
        paragraphs.append("".join(pieces))
    oracle.require(0 < len(paragraphs) <= 8, "unexpected paragraph count")
    text = "\n".join(paragraphs)
    oracle.require(0 < len(text) <= 4096, "unexpected text size")
    return {"text": text, "paragraphs": paragraphs}


if __name__ == "__main__":
    try:
        oracle.require(len(sys.argv) == 2, "usage: workspace-smoke-docx.py FILE.docx")
        print(json.dumps(inspect(Path(sys.argv[1]))))
    except Exception as error:
        print("Workspace autosave DOCX validation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
