import { sizeDisplayName, objectLink, compare } from "../../src/utils/formatutils";

describe("sizeDisplayName", () => {
  it("returns empty string for undefined size", () => {
    expect(sizeDisplayName(undefined)).toBe("");
  });

  it("formats size in base 10 by default", () => {
    expect(sizeDisplayName(0)).toBe("0 B");
    expect(sizeDisplayName(500)).toBe("500 B");
    expect(sizeDisplayName(1000)).toBe("1 KB");
    expect(sizeDisplayName(1500)).toBe("1.5 KB");
    expect(sizeDisplayName(1000000)).toBe("1 MB");
    expect(sizeDisplayName(1500000000)).toBe("1.5 GB");
  });

  it("formats size in base 2 when specified", () => {
    expect(sizeDisplayName(0, true)).toBe("0 B");
    expect(sizeDisplayName(512, true)).toBe("512 B");
    expect(sizeDisplayName(1024, true)).toBe("1 KiB");
    expect(sizeDisplayName(1536, true)).toBe("1.5 KiB");
    expect(sizeDisplayName(1048576, true)).toBe("1 MiB");
    expect(sizeDisplayName(1610612736, true)).toBe("1.5 GiB");
  });
});

describe("objectLink", () => {
  it("returns snapshot directory link for objects starting with 'k'", () => {
    expect(objectLink("k123abc")).toBe("/snapshots/dir/k123abc");
  });

  it("returns snapshot directory link for objects starting with 'Ik'", () => {
    expect(objectLink("Ik123abc")).toBe("/snapshots/dir/Ik123abc");
  });

  it("returns API object link for other objects", () => {
    expect(objectLink("abc123")).toBe("/api/v1/objects/abc123");
    expect(objectLink("x123abc")).toBe("/api/v1/objects/x123abc");
  });
});

describe("compare", () => {
  it("returns negative for a < b", () => {
    expect(compare(1, 2)).toBe(-1);
    expect(compare("a", "b")).toBe(-1);
  });

  it("returns positive for a > b", () => {
    expect(compare(2, 1)).toBe(1);
    expect(compare("b", "a")).toBe(1);
  });

  it("returns zero for a === b", () => {
    expect(compare(1, 1)).toBe(0);
    expect(compare("a", "a")).toBe(0);
  });
});

describe("compactCount", () => {
  it("shortens counts with K, M and B", async () => {
    const { compactCount } = await import("../../src/utils/formatutils");
    expect(compactCount(0)).toBe("0");
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1000)).toBe("1K");
    expect(compactCount(1500)).toBe("1.5K");
    expect(compactCount(12345)).toBe("12.3K");
    expect(compactCount(1311967)).toBe("1.3M");
    expect(compactCount(999960)).toBe("1M");
    expect(compactCount(2100000000)).toBe("2.1B");
    expect(compactCount(undefined)).toBe("");
  });
});
