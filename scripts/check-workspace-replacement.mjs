// Exact read-only review fixtures. Browser memory files do not prove native IO.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1429";
const scenarios = ["literal-output", "literal-special", "unicode", "open-dirty", "open-clean", "stale-disk", "stale-buffer", "stale-review", "root-change", "late-preview", "partial", "invalid-ranges", "replacement-limit", "result-limit", "native-path-alias", "wrong-path-alias", "case-distinct", "keyboard-review"];
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext(), errors = [], network = [];
    try {
      await context.route("**/*", route => {
        const target = new URL(route.request().url());
        if (/^https?:$/.test(target.protocol) && target.origin !== new URL(url).origin) { network.push(target.href); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
      await page.goto(url); await page.waitForSelector(".cm-content");
      await page.evaluate(async scenario => {
        const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts"), p = await import("/src/lib/platform.ts");
        const w = await import("/src/lib/workspaceSearch.ts"), r = await import("/src/lib/workspaceReplacement.ts");
        const check = (value, message) => { if (!value) throw new Error(message); };
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const root = "/Users/you/Notes/review-" + scenario, path = root + "/A/writing.md";
        const original = "🙂 e\u0301 first\nneedle alpha\nlast needle";
        s.getState().setSettings({ autosave: false, historyEnabled: false });
        await p.fsApi.createFile(path, original); await a.openFolder(root);
        let id;
        if (["open-dirty", "open-clean", "stale-buffer", "stale-review"].includes(scenario)) id = await a.openPath(path);
        if (scenario === "open-dirty") a.updateContent(id, original + " unsaved needle");
        if (scenario === "case-distinct") await p.fsApi.createFile(root + "/A/Writing.md", "different needle");
        if (scenario === "unicode") await p.fsApi.writeText(path, "🙂 İ café\nİ", (await p.fsApi.readText(path)).revision);
        w.useWorkspaceSearch.setState({ query: scenario === "unicode" ? "i" : "needle", options: { caseSensitive: scenario !== "unicode", wholeWord: false } });
        await w.runWorkspaceSearch();
        const diskBefore = await p.fsApi.readText(path);
        const docsBefore = JSON.stringify(s.getState().docs.map(d => [d.id, d.path, d.content, d.savedContent]));
        let writes = 0, creates = 0;
        const realWrite = p.fsApi.writeText, realCreate = p.fsApi.createFile;
        p.fsApi.writeText = async (...args) => { writes++; return realWrite(...args); };
        p.fsApi.createFile = async (...args) => { creates++; return realCreate(...args); };
        r.setReplacement(scenario === "literal-special" ? "$1 $& \\ literal\r\nnext" : scenario === "unicode" ? "X" : "replacement");
        if (scenario === "replacement-limit") r.setReplacement("x".repeat(65537));
        if (scenario === "result-limit") r.setReplacement("x".repeat(65536));
        if (scenario === "result-limit") {
          // Captured exact ranges with a large independent before image.
          const text = "needle ".repeat(200) + "x".repeat(2000000);
          await realWrite(path, text, diskBefore.revision); // intentionally invalidates earlier search
          w.useWorkspaceSearch.setState({ query: "needle", options: { caseSensitive: true, wholeWord: false } });
          await w.runWorkspaceSearch();
        }
        if (scenario === "partial") w.useWorkspaceSearch.setState({ coverage: { ...w.useWorkspaceSearch.getState().coverage, partial: true, warnings: ["An unreadable file was skipped."] } });
        if (scenario === "invalid-ranges") {
          const search = w.useWorkspaceSearch.getState();
          w.useWorkspaceSearch.setState({ hits: search.hits.map((hit, i) => i ? { ...hit, from: 12, to: 19 } : hit) });
        }
        if (scenario === "native-path-alias") {
          const { plainPath } = await import("/src/lib/paths.ts");
          check(plainPath("\\\\?\\C:\\Notes\\a.md") === "C:\\Notes\\a.md" && plainPath("\\\\?\\UNC\\host\\share\\a.md") === "\\\\host\\share\\a.md" && plainPath("C:\\Notes") === "C:\\Notes", "Extended-length prefix was not removed");
        }
        if (["native-path-alias", "wrong-path-alias"].includes(scenario)) {
          const search = w.useWorkspaceSearch.getState();
          w.useWorkspaceSearch.setState({ hits: search.hits.map(hit => ({ ...hit, path: "canonical-prefix/" + hit.path, relativePath: scenario === "wrong-path-alias" ? "../writing.md" : hit.relativePath })) });
        }
        if (scenario === "stale-disk") await realWrite(path, "external writing", diskBefore.revision);
        if (scenario === "stale-buffer") a.updateContent(id, "later writing");
        if (scenario === "root-change") await a.openFolder("/Users/you/Notes");
        if (scenario === "late-preview") {
          const read = p.fsApi.readText;
          p.fsApi.readText = async value => { await wait(30); return read(value); };
          const promise = r.previewWorkspaceReplacement();
          await wait(5); r.setReplacement("a newer choice");
          check(!await promise && !r.useWorkspaceReplacement.getState().review, "A late preview replaced a newer choice");
        } else {
          const ok = await r.previewWorkspaceReplacement(), state = r.useWorkspaceReplacement.getState(), review = state.review;
          if (["stale-disk", "stale-buffer", "root-change", "replacement-limit"].includes(scenario)) {
            check(!ok && !review && !!state.error, "A stale or oversized request produced a review");
          } else {
            check(ok && review, "No current review");
            if (["invalid-ranges", "result-limit", "wrong-path-alias", "native-path-alias"].includes(scenario)) {
              // Changed: native search now returns normal paths, so a hit outside the folder is refused instead of re-read through the folder path.
              check(!review.proposals.length && review.partial && review.warnings.length, "Unsafe proposal was not excluded explicitly");
            } else {
              const proposal = review.proposals.find(p => p.path === path);
              check(proposal && !proposal.selected, "File was missing or preselected");
              if (scenario === "literal-output") check(proposal.before === original && proposal.after === "🙂 e\u0301 first\nreplacement alpha\nlast replacement" && proposal.ranges.length === 2, "Exact literal output/count mismatch");
              if (scenario === "literal-special") check(proposal.after === "🙂 e\u0301 first\n$1 $& \\ literal\nnext alpha\nlast $1 $& \\ literal\nnext", "Replacement was interpreted as capture syntax");
              if (scenario === "unicode") check(proposal.after === "🙂 X café\nX" && JSON.stringify(proposal.ranges) === "[[3,4],[10,11]]", "Unicode review lost exact UTF-16 positions");
              if (scenario === "open-dirty") check(proposal.open && proposal.dirty && proposal.source === "buffer" && proposal.ranges.length === 3 && proposal.after.endsWith("unsaved replacement"), "Dirty writing was not reviewed");
              if (scenario === "open-clean") check(proposal.open && !proposal.dirty && proposal.source === "disk", "Saved tab was labelled closed");
              if (scenario === "partial") check(review.partial && review.warnings[0].includes("unreadable"), "Partial coverage was hidden");
              if (scenario === "case-distinct") check(review.proposals.length === 2 && new Set(review.proposals.map(p => p.path)).size === 2, "Case-distinct files merged");
              r.selectReplacement(path, true);
              check(r.useWorkspaceReplacement.getState().review.proposals.filter(p => p.selected).length === 1, "Selection affected another file");
              if (scenario === "stale-review") {
                const captured = proposal.after;
                a.updateContent(id, "later writing");
                const stale = r.useWorkspaceReplacement.getState().review;
                check(stale.stale && stale.proposals[0].after === captured, "Review silently recomputed after editing");
                r.selectReplacement(path, false);
                check(r.useWorkspaceReplacement.getState().review.proposals[0].selected, "Stale review accepted new choices");
              }
            }
          }
        }
        check(writes === 0 && creates === 0, "Preview wrote a source file");
        if (!["stale-disk", "result-limit"].includes(scenario)) check((await p.fsApi.readText(path)).content === diskBefore.content, "Preview changed disk text");
        if (!["stale-buffer", "stale-review", "root-change"].includes(scenario)) check(JSON.stringify(s.getState().docs.map(d => [d.id, d.path, d.content, d.savedContent])) === docsBefore, "Preview changed a tab or its baseline");
        if (scenario === "keyboard-review") {
          r.clearReplacementReview(); s.getState().setSettings({ sidebarOpen: true, sidebarTab: "search" });
        }
      }, scenario);
      if (scenario === "keyboard-review") {
        const panel = page.locator(".workspace-replacement");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        const choice = panel.getByRole("checkbox").first(); await choice.focus(); await page.keyboard.press("Space"); await assert.equal(await choice.isChecked(), true);
        await panel.getByRole("button", { name: "Show before and after" }).click();
        assert.equal(await panel.getByLabel("After A/writing.md", { exact: true }).textContent(), "🙂 e\u0301 first\nreplacement alpha\nlast replacement");
        assert.equal(await panel.getByRole("button", { name: /^Replace in selected files/ }).isDisabled(), true, "Applying without protected history was allowed");
        await page.evaluate(() => { const query = document.querySelector("#workspace-query"); query.value = "new"; query.dispatchEvent(new Event("input", { bubbles: true })); });
        // Actual control change is exercised through keyboard for React's input tracking.
        await page.locator("#workspace-query").fill("something else");
        await choice.waitFor({ state: "visible" }); assert.equal(await choice.isDisabled(), true);
      }
      assert.deepEqual(errors, [], "Browser errors"); assert.deepEqual(network, [], "Unexpected external network");
      console.log("PASS " + scenario);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
