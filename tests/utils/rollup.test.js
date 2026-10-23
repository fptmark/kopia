import { joinTime, nextRollup, parseTime } from "../../src/utils/rollup";

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

describe("nextRollup", () => {
  const at = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m);

  it("daily: later today, or tomorrow once the time has passed", () => {
    const r = { freq: "daily", time: "08:00" };
    expect(nextRollup(r, at(2026, 10, 22, 7, 0))).toEqual(at(2026, 10, 22, 8, 0));
    expect(nextRollup(r, at(2026, 10, 22, 8, 0))).toEqual(at(2026, 10, 23, 8, 0));
    expect(nextRollup(r, at(2026, 10, 31, 9, 0))).toEqual(at(2026, 11, 1, 8, 0));
  });

  it("weekly: the chosen weekday, counting Monday as 0", () => {
    // 22 October 2026 is a Thursday
    expect(nextRollup({ freq: "weekly", weekday: 0, time: "07:30" }, at(2026, 10, 22, 12, 0))).toEqual(
      at(2026, 10, 26, 7, 30),
    );
    expect(nextRollup({ freq: "weekly", weekday: 3, time: "07:30" }, at(2026, 10, 22, 7, 0))).toEqual(
      at(2026, 10, 22, 7, 30),
    );
    expect(nextRollup({ freq: "weekly", weekday: 3, time: "07:30" }, at(2026, 10, 22, 8, 0))).toEqual(
      at(2026, 10, 29, 7, 30),
    );
    expect(nextRollup({ freq: "weekly", weekday: 6, time: "07:30" }, at(2026, 10, 22, 8, 0))).toEqual(
      at(2026, 10, 25, 7, 30),
    );
  });

  it("monthly: a day of the month, the last day, and short months", () => {
    expect(nextRollup({ freq: "monthly", dom: 1, time: "08:00" }, at(2026, 10, 22))).toEqual(at(2026, 11, 1, 8, 0));
    expect(nextRollup({ freq: "monthly", dom: 28, time: "08:00" }, at(2026, 10, 22))).toEqual(at(2026, 10, 28, 8, 0));
    expect(nextRollup({ freq: "monthly", dom: 0, time: "08:00" }, at(2026, 2, 10))).toEqual(at(2026, 2, 28, 8, 0));
    expect(nextRollup({ freq: "monthly", dom: 0, time: "08:00" }, at(2028, 2, 10))).toEqual(at(2028, 2, 29, 8, 0));
    expect(nextRollup({ freq: "monthly", dom: 0, time: "08:00" }, at(2026, 10, 31, 9, 0))).toEqual(
      at(2026, 11, 30, 8, 0),
    );
  });
});
