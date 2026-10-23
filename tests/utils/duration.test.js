import { formatDuration, parseDuration, splitDuration } from "../../src/utils/duration";

describe("splitDuration", () => {
  it("uses the largest unit that divides the period evenly", () => {
    expect(splitDuration(30)).toEqual({ text: "30", unit: "sec" });
    expect(splitDuration(60)).toEqual({ text: "1", unit: "min" });
    expect(splitDuration(90)).toEqual({ text: "90", unit: "sec" });
    expect(splitDuration(600)).toEqual({ text: "10", unit: "min" });
    expect(splitDuration(5400)).toEqual({ text: "90", unit: "min" });
    expect(splitDuration(3600)).toEqual({ text: "1", unit: "hr" });
    expect(splitDuration(43200)).toEqual({ text: "12", unit: "hr" });
    expect(splitDuration(86400)).toEqual({ text: "1", unit: "days" });
    expect(splitDuration(3 * 86400)).toEqual({ text: "3", unit: "days" });
    expect(splitDuration(36 * 3600)).toEqual({ text: "36", unit: "hr" });
  });

  it("shows nothing for no period", () => {
    expect(splitDuration(0)).toEqual({ text: "", unit: "hr" });
    expect(splitDuration(undefined)).toEqual({ text: "", unit: "hr" });
  });
});

describe("parseDuration", () => {
  it("turns a number and a unit into seconds, decimals allowed", () => {
    expect(parseDuration("30", "sec")).toBe(30);
    expect(parseDuration("5", "min")).toBe(300);
    expect(parseDuration("1", "hr")).toBe(3600);
    expect(parseDuration("1.5", "hr")).toBe(5400);
    expect(parseDuration(" 2 ", "days")).toBe(172800);
    expect(parseDuration(".5", "days")).toBe(43200);
  });

  it("refuses anything that is not a plain number", () => {
    for (const bad of ["", "abc", "-1", "1e3", "1,5", "1 hr", "1.2.3"]) {
      expect(parseDuration(bad, "hr")).toBeNull();
    }
  });
});

describe("formatDuration", () => {
  it("writes a period for reading", () => {
    expect(formatDuration(3600)).toBe("1 hr");
    expect(formatDuration(5400)).toBe("90 min");
    expect(formatDuration(2 * 86400)).toBe("2 days");
    expect(formatDuration(45)).toBe("45 sec");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(undefined)).toBe("");
  });
});
