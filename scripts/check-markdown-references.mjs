// Headless parser/source-span oracle, no native or installed-app claim.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1430";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext(), errors = [], network = [];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await context.route("**/*", route => { const target = new URL(route.request().url()); if (/^https?:$/.test(target.protocol) && target.origin !== new URL(url).origin) { network.push(target.href); return route.abort(); } if (target.pathname.startsWith("/Users/you/Notes/oracle/")) return route.fulfill({ contentType: "image/png", body: png }); return route.continue(); });
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  await page.goto(url); await page.waitForSelector(".cm-content");
  const results = await page.evaluate(async () => {
    const { parseMarkdownReferences: parse, resolveReferenceTarget: resolve } = await import("/src/lib/markdownReferences.ts");
    const check = (value, message) => { if (!value) throw new Error(message); }, passed = [];
    const fixture = (source, expected) => {
      const result = parse(source);
      check(JSON.stringify(result.references.map(r => r.target)) === JSON.stringify(expected), "Target oracle mismatch: " + JSON.stringify({ source, result, expected }));
      for (const ref of result.references) {
        check(ref.sourceSpan[0] >= 0 && ref.sourceSpan[1] <= source.length && ref.sourceSpan[0] < ref.sourceSpan[1], "Invalid source span");
        if (ref.destinationSpan) { const raw = source.slice(...ref.destinationSpan); check(raw === "" || ref.target !== null, "Invalid destination span"); }
      }
      return result;
    };
    const text = '🙂 ![a](<assets/æ space.png#crop> "Caption") and [b](notes/next%20page.md#Heading)';
    const inline = fixture(text, ["assets/æ space.png#crop", "notes/next%20page.md#Heading"]);
    check(text.slice(...inline.references[0].destinationSpan) === "assets/æ space.png#crop", "Angle wrapper or Unicode moved exact span");
    check(text.slice(...inline.references[1].destinationSpan) === "notes/next%20page.md#Heading", "Encoded destination span changed"); passed.push("inline-unicode-spans");
    const refs = fixture('![a][photo]\n[x][Photo]\n![photo][]\n[photo]\n\n[PHOTO]: <assets/shared image.png> "Title"\n[photo]: ignored.png', Array(4).fill("assets/shared image.png"));
    check(refs.references.every(r => JSON.stringify(r.destinationSpan) === JSON.stringify(refs.references[0].destinationSpan) && r.definitionSpan), "Shared definition span did not stay unique"); passed.push("reference-first-definition-shared");
    fixture('[ A  B ]\n\n[a b]: image.png', ["image.png"]); passed.push("reference-label-normalization");
    const missing = fixture('[undefined] ![missing]', [null, null]); check(missing.references.every(r => r.destinationSpan === null), "Undefined brackets fabricated a URL"); passed.push("unresolved-reference");
    fixture('`![code](bad.png)`\n\n```md\n[x](bad.md)\n```\n\n    ![indent](bad.png)\n\n![real](good.png)', ["good.png"]); passed.push("code-exclusions");
    const front = '---\r\nimage: "![metadata](bad.png)"\r\n---\r\n![real](good.png)';
    const fm = fixture(front, ["good.png"]); check(front.slice(...fm.references[0].sourceSpan) === "![real](good.png)", "Frontmatter moved original CRLF offsets"); passed.push("frontmatter-exclusion-offsets");
    const html = fixture('<img src="unscanned.png">\n<a href="unknown.md">Link</a>', []); check(html.partial && html.htmlSpans.length && html.warnings.length, "Raw HTML coverage was called complete"); passed.push("raw-html-explicit-coverage");
    fixture('[outer ![inner](picture.png)](page.md)', ["page.md", "picture.png"]); passed.push("nested-image-link");
    fixture('[empty]() ![empty]()', ["", ""]); passed.push("empty-destination");
    fixture('<https://example.invalid/path> <person@example.invalid>', ["https://example.invalid/path", "mailto:person@example.invalid"]); passed.push("autolinks-remote-email");
    fixture('[^note]\n\n[^note]: Footnote text\n\n[actual](real.md)', ["real.md"]); passed.push("footnote-exclusion");
    const footnote = fixture('[^note]\n\n[^note]: footnote.md', []); check(footnote.partial && footnote.warnings.length, "Unscanned footnote definition was called complete");
    fixture('![escaped](assets/a\\(b\\).png)', ["assets/a(b).png"]); passed.push("escaped-punctuation");
    check(resolve("assets/a%20b.png#part%20one", "/notes/A.md").path === "/notes/assets/a b.png" && resolve("assets/a%20b.png#part%20one", "/notes/A.md").fragment === "part one", "Encoded space/fragment oracle");
    check(resolve("assets/a%23b%3Fc.png", "/notes/A.md").path === "/notes/assets/a#b?c.png", "Encoded reserved filename became URL suffix");
    check(resolve("assets/a%2520b.png", "/notes/A.md").path === "/notes/assets/a%20b.png", "Double URL decoding"); passed.push("encoded-path-once");
    check(resolve("../outside/æ.png#crop", "/notes/folder/A.md").path === "/notes/outside/æ.png", "Outside relative path");
    check(resolve("..\\images\\same.png", "C:\\Notes\\Folder\\A.md").path === "C:\\Notes\\images\\same.png", "Windows path resolution");
    check(resolve("/images/same.png", "C:\\Notes\\A.md").path === "/images/same.png", "Root-relative reference resolved differently from the preview"); passed.push("platform-relative-paths");
    for (const target of ["https://example.invalid/image", "mailto:a@example.invalid"]) check(resolve(target, "/notes/A.md").type === "remote", "Remote target became local");
    for (const target of ["//server/share/image.png", "\\\\server\\share\\image.png", "file:///C:/image.png", "%2F%2Fserver/share"]) check(resolve(target, "/notes/A.md").type === "unknown", "Unreviewed/network target was probed");
    check(resolve(null, null).type === "unresolved" && resolve("relative.png", null).type === "unknown" && resolve("#heading", null).type === "fragment" && resolve("data:image/png;base64,abc", null).type === "embedded", "Source-less/non-file policy"); passed.push("no-fetch-and-draft-policy");
    // Same rules as the renderers: the preview (markdown-it) and Styled mode's inline images.
    const { renderMarkdown } = await import("/src/lib/markdown.ts"), { resolvePath } = await import("/src/lib/paths.ts");
    const sources = ["assets/a%20b.png", "<assets/a b.png>", "100%.png", "a%20b%.png", "bad%ZZ.png", "100%25.png", "a%2520b.png", "/images/x.png", "../up/æ.png#crop", "a%23b.png?v=1", "assets/a\\(b\\).png"];
    const docPath = "/notes/oracle/A.md", baseDir = "/notes/oracle";
    for (const written of sources) {
      const source = "![x](" + written + ")", ref = parse(source).references[0], resolved = resolve(ref.target, docPath);
      const html = new DOMParser().parseFromString(renderMarkdown(source, { baseDir }), "text/html").querySelector("img")?.getAttribute("src");
      check(resolved.type === "local" && resolved.path === html && resolved.path === resolvePath(baseDir, ref.target), "Checker and preview disagree: " + JSON.stringify({ written, checker: resolved, preview: html }));
    }
    check(resolve("100%.png", docPath).path === "/notes/oracle/100%.png" && resolve("a%20b%.png", docPath).path === "/notes/oracle/a b%.png", "Lone % oracle");
    passed.push("checker-matches-preview-resolution");
    const limited = parse(Array(2001).fill("[x](a.png)").join(" ")); check(limited.partial && limited.references.length === 2000, "Reference bound hidden");
    check(parse("x".repeat(2 * 1024 * 1024 + 1)).partial, "Source bound hidden"); passed.push("explicit-parser-bounds");
    return passed;
  });
  results.forEach(result => console.log("PASS " + result));
  // Styled mode's inline images resolve to the same files the checker reports.
  const sources = ["assets/a%20b.png", "<assets/a b.png>", "100%.png", "a%20b%.png", "bad%ZZ.png", "a%2520b.png", "../oracle/æ.png#crop", "a%23b.png?v=1", "assets/a\\(b\\).png"];
  const live = await page.evaluate(async sources => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts"), p = await import("/src/lib/platform.ts"), refs = await import("/src/lib/markdownReferences.ts");
    const bridge = (await import("/src/editor/bridge.ts")).bridge, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    s.getState().setSettings({ autosave: false, historyEnabled: false, livePreview: true, viewMode: "write" });
    const path = "/Users/you/Notes/oracle/Live.md", content = "Images\n\n" + sources.map(w => "![x](" + w + ")").join("\n\n");
    await p.fsApi.createFile(path, content);
    const id = await a.openPath(path); for (let n = 0; n < 100 && bridge.viewDocId !== id; n++) await wait(10);
    bridge.view.dispatch({ selection: { anchor: 0 } });
    for (let n = 0; n < 200 && document.querySelectorAll(".cm-content .cm-image img").length < sources.length; n++) await wait(10);
    return { shown: [...document.querySelectorAll(".cm-content .cm-image img")].map(img => img.getAttribute("src")),
      checker: refs.parseMarkdownReferences(content).references.map(r => refs.resolveReferenceTarget(r.target, path).path) };
  }, sources);
  assert.deepEqual(live.shown, live.checker); console.log("PASS checker-matches-styled-mode-images");
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  await context.close();
} finally { await browser.close(); }
