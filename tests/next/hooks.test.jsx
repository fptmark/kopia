import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { useLoad, useDebounced } from "../../src/next/hooks";

function Probe({ load, deps = [], options }) {
  const s = useLoad(load, deps, options);
  return (
    <div>
      <span data-testid="data">{s.data === undefined ? "none" : JSON.stringify(s.data)}</span>
      <span data-testid="error">{s.error ?? ""}</span>
      <span data-testid="loading">{String(s.loading)}</span>
      <button onClick={s.reload}>reload</button>
    </div>
  );
}

describe("useLoad", () => {
  it("loads, then shows the data", async () => {
    const load = vi.fn().mockResolvedValue({ a: 1 });
    render(<Probe load={load} />);
    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent('{"a":1}'));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("reports an error and keeps earlier data when a reload fails", async () => {
    const load = vi.fn().mockResolvedValueOnce("first").mockRejectedValueOnce({ message: "no route to host" });
    render(<Probe load={load} />);
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("first"));
    await act(async () => screen.getByText("reload").click());
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("no route to host"));
    expect(screen.getByTestId("data")).toHaveTextContent("first");
  });

  it("loads again when its dependencies change, and drops an older answer that arrives late", async () => {
    let resolveFirst;
    const load = vi.fn((x) => (x === 1 ? new Promise((r) => (resolveFirst = r)) : Promise.resolve("second")));
    const { rerender } = render(<Probe load={() => load(1)} deps={[1]} />);
    rerender(<Probe load={() => load(2)} deps={[2]} />);
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("second"));
    await act(async () => resolveFirst("first"));
    expect(screen.getByTestId("data")).toHaveTextContent("second");
  });

  it("does nothing while disabled", () => {
    const load = vi.fn().mockResolvedValue(1);
    render(<Probe load={load} options={{ enabled: false }} />);
    expect(load).not.toHaveBeenCalled();
  });

  it("refreshes on an interval without going back to loading", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue("x");
    render(<Probe load={load} options={{ refreshMs: 1000 }} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    vi.useRealTimers();
  });
});

function D({ v }) {
  return <span data-testid="v">{useDebounced(v, 200)}</span>;
}

describe("useDebounced", () => {
  it("follows the value after it settles", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<D v="a" />);
    rerender(<D v="ab" />);
    expect(screen.getByTestId("v")).toHaveTextContent("a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByTestId("v")).toHaveTextContent("ab");
    vi.useRealTimers();
  });
});
