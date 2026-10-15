"""Independent structural fixture oracle. Does not establish reader fidelity."""
import hashlib
import json
import sys
import struct
import zlib
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

root = Path(sys.argv[1])
evidence = json.loads((root / "evidence.json").read_text(encoding="utf-8"))
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main", "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "r": "http://schemas.openxmlformats.org/package/2006/relationships"}
w = "{" + ns["w"] + "}"
for name, rtl in [("node-fixture.docx", False), ("browser-rtl-fixture.docx", True)]:
    with ZipFile(root / name) as archive:
        assert archive.testzip() is None
        for member in archive.namelist():
            if member.endswith((".xml", ".rels")):
                ET.fromstring(archive.read(member))
        document = ET.fromstring(archive.read("word/document.xml"))
        text = "".join(document.itertext())
        for expected in ["æøå", "日本語", "🪶", "العربية English", "Third item", "Fourth item", "Nested bullet", "Deeper bullet", "☐", "☑", "Raw HTML sample", "graph LR", "x^2 + y^2", "footnote requiring explicit fallback", "Missing image", "Remote image"]:
            assert expected in text, (name, expected)
        assert "last reviewed" not in text  # excluded metadata is recorded separately
        for element in ["b", "i", "strike", "highlight", "br", "tbl", "numPr", "bookmarkStart", "hyperlink", "drawing"]:
            assert document.findall(".//w:" + element, ns), (name, element)
        bookmarks = {b.get(w + "name") for b in document.findall(".//w:bookmarkStart", ns)}
        links = document.findall(".//w:hyperlink", ns)
        for link in links:
            anchor = link.get(w + "anchor")
            if anchor:
                assert anchor in bookmarks, (name, anchor)
        assert len([link for link in links if link.get(w + "anchor")]) == 2
        numbered = ET.fromstring(archive.read("word/numbering.xml"))
        assert any(s.get(w + "val") == "3" for s in numbered.findall(".//w:start", ns)), "Ordered start lost"
        assert len(document.findall(".//w:tr", ns)) == 3
        assert document.find(".//w:tblHeader", ns) is not None
        properties = document.find(".//wp:docPr", ns)
        assert properties.get("descr") == "Known local fixture"
        media = [m for m in archive.namelist() if m.startswith("word/media/") and not m.endswith("/")]
        assert len(media) == 1
        image = archive.read(media[0])
        assert hashlib.sha256(image).hexdigest() == evidence["imageSha256"]
        assert image[:8] == b"\x89PNG\r\n\x1a\n"
        position, pixels = 8, b""
        while position < len(image):
            length = struct.unpack(">I", image[position:position + 4])[0]
            chunk = image[position + 4:position + 8 + length]
            checksum = struct.unpack(">I", image[position + 8 + length:position + 12 + length])[0]
            assert zlib.crc32(chunk) == checksum, "Invalid PNG fixture checksum"
            if chunk[:4] == b"IDAT":
                pixels += chunk[4:]
            position += length + 12
        assert zlib.decompress(pixels) == bytes([0, 240, 168, 48, 255])
        rels = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        external = [r.get("Target") for r in rels if r.get("TargetMode") == "External"]
        assert external == ["https://example.invalid/research?q=writing&lang=en"]
        paragraphs = document.findall(".//w:p", ns)
        for paragraph in paragraphs:
            content = "".join(paragraph.itertext())
            bidi = paragraph.find("w:pPr/w:bidi", ns)
            if content.startswith('const literal ='):
                assert bidi is not None and bidi.get(w + "val") in ["0", "false"]
            elif rtl and "Second line" in content:
                assert bidi is not None and bidi.get(w + "val", "1") not in ["0", "false"]
        print("PASS", name, "ZIP XML content styles numbering bookmarks exact image bytes and direction")
print("Reader rendering and native delivery remain UNVERIFIED")
