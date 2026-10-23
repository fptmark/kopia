import moment from "moment";
import { isOverdue } from "../../src/utils/snapshotutil";

describe("isOverdue", () => {
  const now = moment("2026-10-22T12:00:00Z");
  const ago = (hours) => now.clone().subtract(hours, "hours").toISOString();

  it("allows twice the interval plus half an hour, never less than 3 hours", () => {
    expect(isOverdue(ago(2.9), 3600, now)).toBe(false);
    expect(isOverdue(ago(3.1), 3600, now)).toBe(true);
    expect(isOverdue(ago(12), 21600, now)).toBe(false); // every 6 hours: 12.5 h
    expect(isOverdue(ago(13), 21600, now)).toBe(true);
    expect(isOverdue(ago(48), 86400, now)).toBe(false);
    expect(isOverdue(ago(49), 86400, now)).toBe(true);
  });

  it("is never overdue without a snapshot or a known interval", () => {
    expect(isOverdue(null, 3600, now)).toBe(false);
    expect(isOverdue(ago(100), 0, now)).toBe(false);
    expect(isOverdue(ago(100), undefined, now)).toBe(false);
  });
});
