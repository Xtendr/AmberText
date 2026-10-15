// Synthetic full-content history sizing; no user writing or profiles.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const cases = [
  { name: "three ordinary documents, one hour each/day", docs: 3, kib: 20, captures: 17 },
  { name: "twenty long documents, eight hours each/day", docs: 20, kib: 200, captures: 101 },
  { name: "one very large document, eight hours/day", docs: 1, kib: 1024, captures: 101 },
];
const samples = cases.map(c => {
  const text = "# Disposable history sizing fixture\nArabic العربية, Hebrew שלום, emoji 🙂\n";
  const base = text.repeat(Math.ceil(c.kib * 1024 / Buffer.byteLength(text)));
  const retained = c.captures * 7 + 83;
  const blobs = new Map();
  for (let d = 0; d < c.docs; d++) for (let v = 0; v < retained; v++) {
    const bytes = Buffer.from(base + "\nDocument " + d + ", version " + v);
    blobs.set(createHash("sha256").update(bytes).digest("hex"), bytes.length);
  }
  const bytes = [...blobs.values()].reduce((a,b) => a+b, 0);
  return { ...c, retainedPerDocument: retained, distinctBlobs: blobs.size, measuredMiB: +(bytes / 1024 / 1024).toFixed(2), exceeds250MiB: bytes > 250 * 1024 * 1024 };
});
const result = { synthetic: true, includes: "UTF-8 full-content blob bytes; seven days recent captures plus 83 daily samples, excluding small manifests", policyDecision: "Owner delegated selection; enabled by default with bounded retention and removal controls", samples };
if (process.env.AMBERTEXT_HISTORY_SIZING_OUTPUT) writeFileSync(process.env.AMBERTEXT_HISTORY_SIZING_OUTPUT, JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
