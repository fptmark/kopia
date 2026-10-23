import axios from "axios";
import { vi } from "vitest";
import { addIgnoredError, excludeFromBackup, excludePattern } from "../../src/utils/ignoredErrors";

vi.mock("axios");

afterEach(() => vi.resetAllMocks());

describe("excludePattern", () => {
  it("anchors the path to the source", () => {
    expect(excludePattern("Library/Accounts")).toBe("/Library/Accounts");
    expect(excludePattern("/Library/Accounts")).toBe("/Library/Accounts");
  });

  it("escapes the characters that are special in ignore patterns", () => {
    expect(excludePattern("Library/a*b[1]?")).toBe("/Library/a\\*b\\[1\\]\\?");
  });
});

describe("excludeFromBackup", () => {
  const source = { userName: "u", host: "h", path: "/Users/u" };
  const url = "/api/v1/policy?userName=u&host=h&path=%2FUsers%2Fu";

  it("adds the pattern to the policy of the source and keeps the rest of it", async () => {
    axios.get.mockResolvedValue({
      data: { files: { ignore: ["/old"], noParentIgnore: true }, retention: { keepLatest: 3 } },
    });
    axios.put.mockResolvedValue({ data: {} });

    await expect(excludeFromBackup(source, "Library/x")).resolves.toBe("/Library/x");

    expect(axios.put).toHaveBeenCalledWith(url, {
      files: { ignore: ["/old", "/Library/x"], noParentIgnore: true },
      retention: { keepLatest: 3 },
    });
  });

  it("creates the policy when the source has none", async () => {
    axios.get.mockRejectedValue(new Error("not found"));
    axios.put.mockResolvedValue({ data: {} });

    await excludeFromBackup(source, "Library/x");

    expect(axios.put).toHaveBeenCalledWith(url, { files: { ignore: ["/Library/x"] } });
  });

  it("does not add a pattern twice", async () => {
    axios.get.mockResolvedValue({ data: { files: { ignore: ["/Library/x"] } } });
    axios.put.mockResolvedValue({ data: {} });

    await excludeFromBackup(source, "Library/x");

    expect(axios.put.mock.calls[0][1].files.ignore).toEqual(["/Library/x"]);
  });

  it("fails when the policy cannot be saved", async () => {
    axios.get.mockResolvedValue({ data: {} });
    axios.put.mockRejectedValue(new Error("boom"));

    await expect(excludeFromBackup(source, "Library/x")).rejects.toThrow("boom");
  });
});

describe("addIgnoredError", () => {
  it("posts the rule", async () => {
    axios.post.mockResolvedValue({ data: { id: "a" } });

    await expect(addIgnoredError({ path: "a", scope: "file" })).resolves.toEqual({ id: "a" });
    expect(axios.post).toHaveBeenCalledWith("/api/v1/ignored-errors", { path: "a", scope: "file" });
  });
});
