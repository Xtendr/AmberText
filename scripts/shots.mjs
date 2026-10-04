// Visual regression helper: node scripts/shots.mjs [scene ...]
// Renders the browser build (in-memory demo file system) with Edge and saves PNGs to .shots/.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const URL = process.env.SHOTS_URL ?? "http://localhost:1420";
const OUT = ".shots";
mkdirSync(OUT, { recursive: true });

const scenes = {
  async light(page) {},
  async dark(page) {
    await setPrefs(page, { theme: "dark" });
  },
  async palette(page) {
    await page.keyboard.press("Control+P");
    await page.waitForTimeout(250);
  },
  async commands(page) {
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.type("exp");
    await page.waitForTimeout(250);
  },
  async settings(page) {
    await page.keyboard.press("Control+,");
    await page.waitForTimeout(400);
  },
  async settingsWriting(page) {
    await setPrefs(page, { theme: "dark", accent: "ocean" });
    await page.keyboard.press("Control+,");
    await page.waitForTimeout(300);
    await page.locator(".settings-nav button", { hasText: "Writing" }).click();
    await page.waitForTimeout(300);
  },
  async split(page) {
    await page.keyboard.press("Control+2");
    await page.waitForTimeout(1500);
  },
  async read(page) {
    await page.keyboard.press("Control+3");
    await page.waitForTimeout(1500);
  },
  async slash(page) {
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await page.waitForTimeout(350);
  },
  async scrolled(page) {
    await page.locator(".cm-scroller").evaluate((el) => (el.scrollTop = 1400));
    await page.waitForTimeout(1200);
  },
  async scrolledDark(page) {
    await setPrefs(page, { theme: "dark" });
    await page.locator(".cm-scroller").evaluate((el) => (el.scrollTop = 1400));
    await page.waitForTimeout(1200);
  },
  async selection(page) {
    const line = page.locator(".cm-line").nth(4);
    const box = await line.boundingBox();
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  },
  async find(page) {
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+F");
    await page.keyboard.type("markdown");
    await page.waitForTimeout(300);
  },
  async outline(page) {
    await page.locator(".seg-btn", { hasText: "Outline" }).click();
    await page.waitForTimeout(300);
  },
  async welcome(page) {
    await page.keyboard.press("Control+W");
    await page.waitForTimeout(400);
  },
  async flow(page) {
    await page.locator(".tree-row", { hasText: "Projects" }).click();
    await page.locator(".tree-row", { hasText: "Design principles" }).click();
    await page.waitForTimeout(400);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\n- A new thought that is long enough to wrap onto a second line in the editor so we can check the hanging indent\n");
    await page.waitForTimeout(200);
    const dirty = await page.locator(".tab.is-active .tab-dirty, .tab.is-active .is-dirty").count();
    console.log("[flow] dirty marker:", dirty);
    await page.keyboard.press("Control+S");
    await page.waitForTimeout(500);
    console.log("[flow] status:", await page.locator(".statusbar").innerText());
    await page.keyboard.press("Control+Tab");
    await page.waitForTimeout(300);
    console.log("[flow] tabs:", await page.locator(".tab").allInnerTexts());
    await page.keyboard.press("Control+Tab");
    await page.waitForTimeout(300);
  },
  async zen(page) {
    await page.keyboard.press("Control+Shift+Enter");
    await page.waitForTimeout(600);
  },
};

async function setPrefs(page, patch) {
  await page.evaluate((patch) => {
    const raw = localStorage.getItem("margin:prefs");
    const data = raw ? JSON.parse(raw) : { state: {}, version: 1 };
    data.state.settings = { ...(data.state.settings ?? {}), ...patch };
    localStorage.setItem("margin:prefs", JSON.stringify(data));
  }, patch);
  await page.reload();
  await page.waitForSelector(".cm-content, .welcome");
  await page.waitForTimeout(700);
}

const wanted = process.argv.slice(2);
const list = wanted.length ? wanted : Object.keys(scenes);
const browser = await chromium.launch({ channel: "msedge" });
for (const name of list) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[${name}] console:`, m.text()));
  page.on("pageerror", (e) => console.log(`[${name}] pageerror:`, e.message));
  page.on("response", (r) => r.status() >= 400 && console.log(`[${name}] ${r.status()}`, r.url()));
  await page.goto(URL);
  await page.waitForSelector(".cm-content, .welcome");
  await page.waitForTimeout(900);
  await scenes[name](page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
  await ctx.close();
}
await browser.close();
