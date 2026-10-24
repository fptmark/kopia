import { describe, it, expect } from "vitest";
import {
  cleanPolicy,
  definedBy,
  getPath,
  parseTimeOfDay,
  setPath,
  textToLines,
  textToTimes,
  timesToText,
} from "../../src/next/policy/helpers";
import { ALL_FIELDS, SECTIONS } from "../../src/next/policy/fields";

describe("policy helpers", () => {
  it("reads and sets nested values without touching the original", () => {
    const p = { retention: { keepLatest: 10 } };
    const q = setPath(p, "retention.keepDaily", 30);
    expect(q).toEqual({ retention: { keepLatest: 10, keepDaily: 30 } });
    expect(p).toEqual({ retention: { keepLatest: 10 } });
    expect(getPath(q, "retention.keepDaily")).toBe(30);
    expect(getPath(q, "files.ignore")).toBeUndefined();
    expect(getPath(undefined, "a.b")).toBeUndefined();
  });

  it("keeps zero and false, and drops empty values and the objects they leave empty", () => {
    let p = setPath({}, "retention.keepLatest", 0);
    p = setPath(p, "files.oneFileSystem", false);
    expect(p).toEqual({ retention: { keepLatest: 0 }, files: { oneFileSystem: false } });

    p = setPath(p, "retention.keepLatest", undefined);
    p = setPath(p, "files.oneFileSystem", undefined);
    expect(p).toEqual({});
    expect(setPath({ a: { b: ["x"] } }, "a.b", [])).toEqual({});
    expect(setPath({}, "a.b", "")).toEqual({});
  });

  it("parses times of day, leaving what is not a time as text", () => {
    expect(parseTimeOfDay("9:30")).toEqual({ hour: 9, min: 30 });
    expect(parseTimeOfDay(" 21:05 ")).toEqual({ hour: 21, min: 5 });
    expect(parseTimeOfDay("24:00")).toBe("24:00");
    expect(parseTimeOfDay("9:5")).toBe("9:5");
    expect(parseTimeOfDay("noon")).toBe("noon");
    expect(timesToText(textToTimes("9:30\n21:05"))).toBe("9:30\n21:05");
    expect(textToTimes("")).toBeUndefined();
    expect(textToLines("a\nb")).toEqual(["a", "b"]);
  });

  it("cleans a policy for saving: no empty lines, times checked, actions without a script dropped", () => {
    const p = {
      files: { ignoreDotFiles: [" .kopiaignore ", "", "  "] },
      compression: { neverCompress: [""] },
      scheduling: { timeOfDay: [{ hour: 9, min: 0 }, ""] },
      actions: { beforeSnapshotRoot: { script: "backup.sh" }, afterFolder: { script: "", timeout: 5 } },
    };
    const c = cleanPolicy(p);
    expect(c.files.ignoreDotFiles).toEqual([".kopiaignore"]);
    expect(c.compression).toBeUndefined();
    expect(c.scheduling.timeOfDay).toEqual([{ hour: 9, min: 0 }]);
    expect(c.actions.beforeSnapshotRoot).toEqual({ script: "backup.sh", timeout: 300 });
    expect(c.actions.afterFolder).toBeUndefined();
    expect(p.files.ignoreDotFiles).toHaveLength(3); // the original is left alone
  });

  it("refuses a time of day that is still text", () => {
    expect(() => cleanPolicy({ scheduling: { timeOfDay: ["noon"] } })).toThrow(/Invalid time of day: 'noon'/);
  });

  it("says where a value comes from", () => {
    const here = { userName: "me", host: "mac", path: "/Users/me" };
    expect(definedBy(here, here)).toBe("this policy");
    expect(definedBy({ userName: "", host: "", path: "" }, here)).toBe("the global policy");
    expect(definedBy({ userName: "", host: "mac", path: "" }, here)).toBe("host mac");
    expect(definedBy({ userName: "me", host: "mac", path: "" }, here)).toBe("user me@mac");
    expect(definedBy({ userName: "me", host: "mac", path: "/Users" }, here)).toBe("/Users");
    expect(definedBy(undefined, here)).toBe("");
  });
});

describe("policy fields", () => {
  it("has unique settings with a label and a known type", () => {
    const types = new Set(["number", "bool", "flag", "select", "lines", "duration", "times", "text", "readonly"]);
    const paths = ALL_FIELDS.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const f of ALL_FIELDS) {
      expect(types.has(f.type), f.path).toBe(true);
      expect(f.label, f.path).toBeTruthy();
    }
  });

  it("covers every section of the old editor", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      "retention",
      "scheduling",
      "files",
      "errors",
      "compression",
      "upload",
      "actions",
      "logging",
      "advanced",
    ]);
  });

  it("points the ignore rules at the Exclusions page instead of editing them", () => {
    const f = ALL_FIELDS.find((x) => x.path === "files.ignore");
    expect(f.type).toBe("readonly");
    expect(f.link).toBe("/exclusions");
  });
});
