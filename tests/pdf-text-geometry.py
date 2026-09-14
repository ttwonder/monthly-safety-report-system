#!/usr/bin/env python3
"""Return page/text bounding boxes from a PDF as JSON."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import fitz


def main() -> int:
    if len(sys.argv) < 3:
        raise SystemExit("usage: pdf-text-geometry.py PDF MARKER [MARKER ...]")

    pdf_path = Path(sys.argv[1])
    markers = sys.argv[2:]
    matches: dict[str, list[dict[str, float | int | str]]] = {
        marker: [] for marker in markers
    }

    with fitz.open(pdf_path) as document:
        for page_index, page in enumerate(document):
            for word in page.get_text("words", sort=True):
                x0, y0, x1, y1, text = word[:5]
                for marker in markers:
                    if marker == text:
                        matches[marker].append(
                            {
                                "page_index": page_index,
                                "x0": round(float(x0), 3),
                                "y0": round(float(y0), 3),
                                "x1": round(float(x1), 3),
                                "y1": round(float(y1), 3),
                                "text": text,
                            }
                        )

        result = {
            "page_count": document.page_count,
            "matches": matches,
        }

    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
