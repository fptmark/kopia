import { joinTime, ordinal, parseTime } from "../../src/utils/rollup";

describe("roll-up time", () => {
  it("converts between 24-hour storage and hour, minute, AM/PM", () => {
    expect(parseTime("00:00")).toEqual({ h: 12, m: 0, ap: "AM" });
    expect(parseTime("08:05")).toEqual({ h: 8, m: 5, ap: "AM" });
    expect(parseTime("12:30")).toEqual({ h: 12, m: 30, ap: "PM" });
    expect(parseTime("23:55")).toEqual({ h: 11, m: 55, ap: "PM" });

    expect(joinTime(12, 0, "AM")).toBe("00:00");
    expect(joinTime(8, 5, "AM")).toBe("08:05");
    expect(joinTime(12, 30, "PM")).toBe("12:30");
    expect(joinTime(11, 55, "PM")).toBe("23:55");
  });

  it("round-trips every time of day", () => {
    for (let h = 0; h < 24; h++) {
      const s = String(h).padStart(2, "0") + ":15";
      const t = parseTime(s);
      expect(joinTime(t.h, t.m, t.ap)).toBe(s);
    }
  });
});

describe("ordinal", () => {
  it("writes day numbers", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "28th",
    ]);
  });
});
