import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import {
  addExclusions,
  describePattern,
  isPathStyle,
  loadNetRules,
  previewExclusions,
  reconcileExclusions,
  removeExclusion,
} from "../../src/next/exclusions";

vi.mock("axios");

describe("describePattern", () => {
  it("tells any-depth patterns from ones anchored at the source root", () => {
    expect(describePattern("node_modules/")).toMatchObject({ anchored: false, foldersOnly: true, scope: "Any depth" });
    expect(describePattern("*.tmp")).toMatchObject({ anchored: false, foldersOnly: false, wildcard: true });
    expect(describePattern("/Library/Caches")).toMatchObject({ anchored: true, scope: "From the source root" });
    expect(describePattern("Projects/**/build/")).toMatchObject({ anchored: true, foldersOnly: true, wildcard: true });
    expect(describePattern("Library/Caches/")).toMatchObject({ anchored: true });
    expect(describePattern(".DS_Store")).toMatchObject({
      anchored: false,
      foldersOnly: false,
      what: "files and folders",
    });
  });

  it("calls a pattern with a path in it path style", () => {
    expect(isPathStyle("node_modules/")).toBe(false);
    expect(isPathStyle("Library/Caches/")).toBe(true);
    expect(isPathStyle("/x")).toBe(true);
  });
});

describe("exclusions API", () => {
  beforeEach(() => {
    axios.get.mockReset().mockResolvedValue({ data: { ok: 1 } });
    axios.post.mockReset().mockResolvedValue({ data: { ok: 2 } });
    axios.delete.mockReset().mockResolvedValue({ data: { ok: 3 } });
  });

  it("sends rules with who added them", async () => {
    await addExclusions([{ source: "/Users/me", pattern: "x/" }], "compare");
    expect(axios.post).toHaveBeenCalledWith("/api/v1/exclusions", {
      rules: [{ source: "/Users/me", pattern: "x/" }],
      addedBy: "compare",
    });
  });

  it("removes by id, asks for the net rules of a source, reconciles and previews", async () => {
    await removeExclusion("a b");
    expect(axios.delete).toHaveBeenCalledWith("/api/v1/exclusions/a%20b");

    await loadNetRules("/Users/me");
    expect(axios.get).toHaveBeenCalledWith("/api/v1/exclusions/net", { params: { source: "/Users/me" } });

    await reconcileExclusions();
    expect(axios.post).toHaveBeenLastCalledWith("/api/v1/exclusions/reconcile", {});
    await reconcileExclusions(["/a"]);
    expect(axios.post).toHaveBeenLastCalledWith("/api/v1/exclusions/reconcile", { sources: ["/a"] });

    await previewExclusions("/Users/me", ["a/"]);
    expect(axios.post).toHaveBeenLastCalledWith("/api/v1/exclusions/preview", {
      source: "/Users/me",
      patterns: ["a/"],
    });
  });
});
