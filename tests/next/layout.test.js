import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/next");

const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.jsx$/.test(e.name) ? [p] : [];
  });

const scan = (re) =>
  files(SRC).flatMap((f) =>
    [...fs.readFileSync(f, "utf8").matchAll(re)].map((m) => `${path.relative(SRC, f)}: ${m[0].trim()}`),
  );

// Layout comes from <Page>, <Panel>, <Toolbar> and the nx-* classes, never from per-element overrides,
// so every page spaces, aligns and sizes things the same way.
describe("layout stays in the shared components", () => {
  it("has no Bootstrap spacing or flex utilities in class names", () => {
    const utility =
      /^(?:m[tbsexy]?|p[tbsexy]?)-(?:[0-5]|auto)$|^d-(?:inline-)?flex$|^gap-\d$|^justify-content-|^align-items-|^flex-(?:wrap|grow-\d)$/;
    const bad = files(SRC).flatMap((f) =>
      [...fs.readFileSync(f, "utf8").matchAll(/className="([^"]*)"/g)]
        .filter((m) => m[1].split(/\s+/).some((c) => utility.test(c)))
        .map((m) => `${path.relative(SRC, f)}: ${m[1]}`),
    );
    expect(bad).toEqual([]);
  });
  it("uses no Bootstrap grid, tables or tabs directly", () => {
    expect(
      scan(/from ["']react-bootstrap\/(?:Row|Col|Container|Table|Nav|Navbar|Tabs|Tab|Card|ListGroup)["']/g).filter(
        (x) => !x.startsWith("ui/"),
      ),
    ).toEqual([]);
  });
  it("sets no inline margins or padding", () => {
    expect(scan(/style=\{\{[^}]*\b(?:margin|padding)\w*:/g)).toEqual([]);
  });
  it("formats counts and dates through format.js, not toLocaleString", () => {
    const bad = files(SRC)
      .filter((f) => !f.endsWith("format.js"))
      .flatMap((f) =>
        [...fs.readFileSync(f, "utf8").matchAll(/\.toLocale\w*String\(/g)].map(
          (m) => `${path.relative(SRC, f)}: ${m[0]}`,
        ),
      );
    expect(bad).toEqual([]);
  });
  it("names task states through TaskStatus, not as quoted words", () => {
    expect(
      scan(/["'](?:RUNNING|CANCELING|SUCCESS|FAILED|CANCELED)["']/g).filter((x) => !x.startsWith("tasks.js")),
    ).toEqual([]);
  });
  it("copies and filters through format.js, so every page behaves the same", () => {
    expect(scan(/navigator\.clipboard|\.toLowerCase\(\)\.includes\(/g)).toEqual([]);
  });

  it("writes a source as user@host:/path in one place", () => {
    expect(scan(/\.userName\s*\+\s*"@"|\$\{[\w.]*userName\}@/g)).toEqual([]);
  });
});
