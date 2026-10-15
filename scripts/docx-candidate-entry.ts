// Typed browser bundle probe only; not an app command or production adapter.
import { Document, Packer, Paragraph, TextRun, ImageRun, FootnoteReferenceRun } from "docx";

export async function candidatePacket(bytes: Uint8Array) {
  const document = new Document({ footnotes: { 1: { children: [new Paragraph("Native Word footnote fixture")] } }, sections: [{ children: [
    new Paragraph({ bidirectional: true, children: [new TextRun({ text: "العربية English", rightToLeft: true }), new FootnoteReferenceRun(1)] }),
    new Paragraph({ bidirectional: false, children: [new TextRun({ text: "const source = 1;", rightToLeft: false })] }),
    new Paragraph({ children: [new ImageRun({ type: "png", data: bytes, transformation: { width: 32, height: 32 }, altText: { name: "Fixture", description: "Disposable image" } })] }),
  ] }] });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}
