import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/next");

const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(jsx?|js)$/.test(e.name) ? [p] : [];
  });

// The first segment of every page the app defines: <Route path="tasks/:tid"> and the tabs in NextApp.
const app = fs.readFileSync(path.join(SRC, "NextApp.jsx"), "utf8");
const known = new Set(
  [...app.matchAll(/<Route path="([^"*]+)"/g)].map((m) => m[1].replace(/^\//, "").split("/")[0]).filter(Boolean),
);

describe("links inside the app", () => {
  it("only point at pages the app defines", () => {
    const bad = [];
    for (const f of files(SRC)) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:<Link[^>]*\sto=|<Navigate[^>]*\sto=|navigate\(|\bto=\{?)["'`]\/([a-z-]+)/g)) {
        if (!known.has(m[1])) {
          bad.push(`${path.relative(SRC, f)}: /${m[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
