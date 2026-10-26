import { describe, it, expect } from "vitest";
import {
  baseName,
  formatAgo,
  formatDate,
  formatDateTime,
  formatLongDateTime,
  setSummaryDateFormat,
  formatSizeChange,
  formatSpan,
  plural,
} from "../../src/next/format";

describe("format", () => {
  it("formats dates and tolerates empty or bad input", () => {
    expect(formatDateTime("2026-10-23T17:22:07Z")).toMatch(/Oct 23, 2026/);
    expect(formatDate("2026-10-23T17:22:07Z")).toBe("Oct 23, 2026");
    expect(formatDateTime("")).toBe("");
    expect(formatDateTime(undefined)).toBe("");
    expect(formatDateTime("not a date")).toBe("");
  });

  it("writes dates in the chosen summary format and always long for a drill-in page", () => {
    const t = new Date(2026, 9, 26, 7, 5).toISOString();
    try {
      setSummaryDateFormat("iso");
      expect(formatDateTime(t)).toBe("2026-10-26 07:05");
      setSummaryDateFormat("numeric");
      expect(formatDateTime(t)).toMatch(/^10\/26\/2026, 7:05\sAM$/);
      setSummaryDateFormat("nonsense");
      expect(formatDateTime(t)).toMatch(/^Oct 26, 2026, 7:05\sAM$/);
      expect(formatLongDateTime(t)).toMatch(/^Monday, October 26, 2026 at 7:05:00\sAM$/);
      expect(formatLongDateTime("")).toBe("");
    } finally {
      setSummaryDateFormat("medium");
    }
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const ago = (s) => formatAgo(new Date(now - s * 1000).toISOString(), now);
    expect(ago(10)).toBe("just now");
    expect(ago(300)).toBe("5 min ago");
    expect(ago(3 * 3600)).toBe("3 h ago");
    expect(ago(2 * 86400)).toBe("2 d ago");
    expect(ago(60 * 86400)).toMatch(/2026/);
    expect(formatAgo("", now)).toBe("");
  });

  it("formats spans", () => {
    expect(formatSpan(850)).toBe("850 ms");
    expect(formatSpan(42000)).toBe("42 s");
    expect(formatSpan(125000)).toBe("2 min 5 s");
    expect(formatSpan(3900000)).toBe("1 h 5 min");
    expect(formatSpan(undefined)).toBe("");
  });

  it("formats size changes with a sign", () => {
    expect(formatSizeChange(1500000)).toBe("+1.5 MB");
    expect(formatSizeChange(-300000000)).toBe("-300 MB");
  });

  it("pluralises with short counts", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(1311967, "file")).toBe("1.3M files");
  });

  it("takes the last part of a path", () => {
    expect(baseName("Projects/a/node_modules")).toBe("node_modules");
    expect(baseName("Projects/a/")).toBe("a");
    expect(baseName("x")).toBe("x");
  });
});
