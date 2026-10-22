import { describe, test, expect } from "vitest";
import { shortTaskError, taskErrorHint } from "../../src/utils/taskutil";

const SFTP =
  "error opening repository: unable to open repository: cannot open storage: unable to open SFTP storage: " +
  "error establishing connecting: unable to dial [fulcrum.local:22]: &ssh.ClientConfig{Config:ssh.Config{Rand:io.Reader(nil)}, " +
  'User:"backup"}: dial tcp 192.168.0.214:22: connect: no route to host';

describe("shortTaskError", () => {
  test("keeps the innermost cause of a long error chain", () => {
    expect(shortTaskError(SFTP)).toBe("connect: no route to host");
    expect(shortTaskError("unable to open file: open /Users/x/Library/Mail: operation not permitted")).toBe(
      "open /Users/x/Library/Mail: operation not permitted",
    );
  });

  test("handles empty, single-part and very long messages", () => {
    expect(shortTaskError("")).toBe("");
    expect(shortTaskError(undefined)).toBe("");
    expect(shortTaskError("canceled")).toBe("canceled");
    expect(shortTaskError("a: " + "x".repeat(300)).length).toBeLessThanOrEqual(141);
  });
});

describe("taskErrorHint", () => {
  test("explains the macOS Local Network and Full Disk Access failures", () => {
    expect(taskErrorHint(SFTP)).toMatch(/Local Network/);
    expect(taskErrorHint("open /x: operation not permitted")).toMatch(/Full Disk Access/);
  });

  test("has no hint for other errors", () => {
    expect(taskErrorHint("something else broke")).toBe("");
    expect(taskErrorHint(undefined)).toBe("");
  });
});
