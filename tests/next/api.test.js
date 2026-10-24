import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { errorMessage, setupApi } from "../../src/next/api";

describe("errorMessage", () => {
  it("prefers the server's message, then its error, then the request's own", () => {
    expect(errorMessage({ message: "net", response: { data: { message: "policy locked" } } })).toBe("policy locked");
    expect(errorMessage({ message: "net", response: { data: { error: "not found" } } })).toBe("not found");
    expect(errorMessage({ message: "Network Error" })).toBe("Network Error");
    expect(errorMessage({ response: { data: "Access denied.\n" }, message: "401" })).toBe("Access denied.");
    expect(errorMessage({ response: { data: "x".repeat(400) }, message: "bad" })).toBe("bad");
    expect(errorMessage(undefined)).toBe("unknown error");
  });
});

describe("setupApi", () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.head.innerHTML = '<meta name="kopia-csrf-token" content="tok123" />';
  });

  it("sends the token the server put in the page, and reloads once when the server was restarted", async () => {
    const handlers = [];
    const spy = vi.spyOn(axios.interceptors.response, "use").mockImplementation((_ok, fail) => handlers.push(fail));
    setupApi();
    expect(axios.defaults.headers.common["X-Kopia-Csrf-Token"]).toBe("tok123");

    const reload = vi.fn();
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/snapshots", reload, replace },
    });

    await expect(handlers[0]({ response: { status: 401, data: "invalid CSRF token" } })).rejects.toBeTruthy();
    await expect(handlers[0]({ response: { status: 401, data: "invalid CSRF token" } })).rejects.toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);

    await expect(handlers[0]({ response: { status: 400, data: { code: "NOT_CONNECTED" } } })).rejects.toBeTruthy();
    expect(replace).toHaveBeenCalledWith("/repo");
    spy.mockRestore();
  });
});
