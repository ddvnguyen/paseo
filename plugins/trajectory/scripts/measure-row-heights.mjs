// Measures the real rendered height of every ledger row class, in a real
// browser, and prints them next to the constants the component ships.
//
//   node scripts/measure-row-heights.mjs
//
// jsdom cannot do this. react-native-web's VirtualizedList returns early while
// visibleLength/contentLength are 0 (VirtualizedList/index.js:810-812) and jsdom
// never sets them, so a window or an offset measured there is fiction. This
// mounts the real LedgerScreen through react-native-web in Chromium and reads
// the height of the item WRAPPERS VirtualizedList positions — not the inner
// elements, which can be a pixel or two shorter than the box the list lays out.
//
// Playwright and esbuild are resolved from the workspace, the way
// vitest.config.ts resolves vitest: plugins/ is not a workspace member and has
// no install of its own.

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const repoRoot = resolve(pluginDir, "..", "..");
const appPkg = join(repoRoot, "packages", "app");
const pluginPkg = join(repoRoot, "packages", "plugin");

/** Declared heights, read from the source so the comparison cannot drift. */
function declaredHeights() {
  const screen = readFileSync(join(pluginDir, "client", "ledger-screen.tsx"), "utf8");
  const rows = readFileSync(join(pluginDir, "shared", "dsh", "virtual-rows.ts"), "utf8");
  const pick = (source, name) => {
    const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
    if (match === null) throw new Error(`${name} not found in source`);
    return Number(match[1]);
  };
  return {
    "turn-header": pick(screen, "TURN_HEADER_HEIGHT"),
    "step-header": pick(screen, "STEP_HEADER_HEIGHT"),
    "turn-rule": pick(screen, "TURN_RULE_HEIGHT"),
    "cellrow:content": pick(rows, "CONTENT_ROW_HEIGHT"),
  };
}

const VIEWPORTS = [
  { name: "desktop 1280x900", width: 1280, height: 900 },
  { name: "phone 390x844", width: 390, height: 844 },
];

/** A deliberately long single-line label: the cell clamps to one line, so a
 *  content row must not grow. If it does, the row is content-dependent and a
 *  single constant is not viable. */
const LONG =
  "run every single integration test in the whole monorepo with coverage enabled and no cache and also verify the failing assertion was fixed";

function entrySource() {
  return `
import React from "react";
import { createRoot } from "react-dom/client";
import { LedgerScreen } from ${JSON.stringify(join(pluginDir, "client", "ledger-screen.js"))};
import { FIXTURE_OPEN_CALLS, FIXTURE_TURN_NUMBERS } from ${JSON.stringify(join(pluginDir, "client", "fixtures.js"))};

const THEME = { colors: { surface0: "#000", surface1: "#111", surface2: "#222", border: "#333",
  foreground: "#fff", foregroundMuted: "#aaa", accent: "#0af", accentForeground: "#fff",
  statusSuccess: "#0f0", statusWarning: "#ff0", statusDanger: "#f00" } };

const long = ${JSON.stringify(LONG)};
const rows = [
  { seq: 0, timeMs: 0, kind: "user", label: long, durationMs: null, callId: "", turnId: "t1", step: null },
  { seq: 1, timeMs: 1, kind: "message", label: long, durationMs: 5, callId: "", turnId: "t1", step: 1 },
  { seq: 2, timeMs: 2, kind: "tool", label: "shell · " + long, durationMs: 2400, callId: "c1", turnId: "t1", step: 1, outputChars: 1520 },
  // A SECOND turn, so the inter-turn rule renders. A one-turn fixture measures
  // three of the four classes and reports success, which is the blind
  // instrument failure this script exists to prevent.
  { seq: 3, timeMs: 3, kind: "user", label: long, durationMs: null, callId: "", turnId: "t2", step: null },
  { seq: 4, timeMs: 4, kind: "message", label: long, durationMs: 5, callId: "", turnId: "t2", step: 1 },
];

declare global { interface Window { __setCompact: (c: boolean) => void } }
function App() {
  const [compact, setCompact] = React.useState(false);
  window.__setCompact = setCompact;
  return <LedgerScreen rows={rows} turnNumbers={FIXTURE_TURN_NUMBERS} openCallIds={FIXTURE_OPEN_CALLS} compact={compact} theme={THEME} />;
}
createRoot(document.getElementById("root")).render(<App />);
`;
}

const work = mkdtempSync(join(tmpdir(), "trajectory-row-heights-"));
try {
  const entry = join(work, "entry.tsx");
  writeFileSync(entry, entrySource());

  // esbuild and playwright are resolved from the workspace install.
  const { build } = await resolveEsbuild();
  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: join(work, "bundle.js"),
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    target: "es2022",
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"development"', global: "globalThis" },
    alias: {
      "react-native": join(appPkg, "node_modules", "react-native-web"),
      react: join(pluginPkg, "node_modules", "react"),
      "react-dom/client": join(appPkg, "node_modules", "react-dom", "client.js"),
      "react-dom": join(appPkg, "node_modules", "react-dom"),
      zod: join(pluginPkg, "node_modules", "zod"),
    },
  });

  writeFileSync(
    join(work, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}</style></head><body><div id="root"></div><script src="./bundle.js"></script></body></html>',
  );

  const { chromium } = await import(join(appPkg, "node_modules", "playwright", "index.mjs"));
  const browser = await chromium.launch();
  const measured = new Map();
  for (const viewport of VIEWPORTS) {
    for (const compact of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });
      await page.goto(`file://${join(work, "index.html")}`);
      await page.waitForSelector('[data-testid="ledger-list"]');
      await page.evaluate((c) => window.__setCompact(c), compact);
      await page.click('[data-testid="toggle-turns"]');
      await page.click('[data-testid="toggle-calls"]');
      await page.waitForTimeout(400);
      const rows = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="ledger-list"]');
        return [...list.firstElementChild.children].map((item) => {
          const el = item.querySelector("[data-testid]");
          const id = el === null ? "" : (el.getAttribute("data-testid") ?? "");
          let cls = "unknown";
          if (id.startsWith("turn-header-")) cls = "turn-header";
          else if (id.startsWith("step-header-")) cls = "step-header";
          else if (id === "turn-rule") cls = "turn-rule";
          else if (id.startsWith("listrow-")) cls = "cellrow:content";
          return { cls, h: item.getBoundingClientRect().height };
        });
      });
      await page.close();
      for (const row of rows) {
        const bucket = measured.get(row.cls) ?? new Set();
        bucket.add(row.h);
        measured.set(row.cls, bucket);
      }
      console.log(`measured ${viewport.name} compact=${compact}`);
    }
  }
  const browserVersion = browser.version();
  await browser.close();

  const declared = declaredHeights();
  console.log(`\nchromium ${browserVersion}`);
  console.log("row class              measured        declared   verdict");
  let failed = false;
  for (const [cls, values] of [...measured].sort()) {
    const seen = [...values].sort((a, b) => a - b);
    const measuredText = seen.map((h) => h.toFixed(1)).join(", ");
    const want = declared[cls];
    const stable = seen.length === 1;
    let verdict = "MISMATCH";
    if (stable && want === seen[0]) verdict = "OK";
    else if (!stable) verdict = "UNSTABLE";
    if (verdict !== "OK") failed = true;
    console.log(
      `  ${cls.padEnd(22)} ${measuredText.padEnd(14)} ${String(want).padEnd(10)} ${verdict}`,
    );
  }
  for (const cls of Object.keys(declared)) {
    if (!measured.has(cls)) {
      console.log(`  ${cls.padEnd(22)} NOT MEASURED`);
      failed = true;
    }
  }
  if (failed) {
    console.log(
      "\nA MISMATCH means getItemLayout would mis-scroll: fix the constant, do not adjust the test.\nA NOT MEASURED means the fixture stopped producing that row, so the constant is unverified.",
    );
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

async function resolveEsbuild() {
  // esbuild ships as vite's dependency; walk the repo install for it.
  const candidates = [
    join(pluginPkg, "node_modules", "esbuild", "lib", "main.js"),
    join(appPkg, "node_modules", "esbuild", "lib", "main.js"),
  ];
  for (const candidate of candidates) {
    try {
      return await import(`file://${candidate}`);
    } catch {
      continue;
    }
  }
  throw new Error("esbuild not found in the workspace install");
}
