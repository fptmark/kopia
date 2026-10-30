import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { RouterProvider, createMemoryRouter } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { Snapshots } from "../../../src/next/pages/Snapshots";
import { sizeJump, uploadProgress } from "../../../src/next/snapshots";

vi.mock("axios");
vi.mock("../../../src/components/SnapshotFrequency", () => ({ SnapshotFrequency: () => <span>frequency</span> }));

const src = (path, user = "me") => ({ userName: user, host: "mac", path });
const sources = (over = {}) => ({
  localUsername: "me",
  localHost: "mac",
  multiUser: false,
  sources: [
    {
      source: src("/Users/me"),
      status: "IDLE",
      lastSnapshot: {
        startTime: new Date(Date.now() - 3600e3).toISOString(),
        stats: { totalSize: 230e9 },
        rootEntry: { summ: { numFailed: 6, errors: [{ path: "a", error: "denied" }] } },
      },
      schedule: { intervalSeconds: 3600 },
    },
    {
      source: src("/Applications"),
      status: "IDLE",
      overdue: true,
      lastSnapshot: { startTime: new Date(Date.now() - 40 * 3600e3).toISOString(), stats: { totalSize: 47e9 } },
      schedule: { intervalSeconds: 3600 },
    },
    { source: src("/Other", "you"), status: "PAUSED", schedule: {} },
  ],
  ...over,
});

const renderPage = (prefs = {}) => {
  const router = createMemoryRouter([{ path: "*", element: <Snapshots /> }]);
  return render(
    <UIPreferencesContext.Provider
      value={{ pageSize: 25, bytesStringBase2: false, setDefaultSnapshotViewAll: vi.fn(), ...prefs }}
    >
      <RouterProvider router={router} />
    </UIPreferencesContext.Provider>,
  );
};

describe("Snapshots page", () => {
  beforeEach(() => {
    axios.get.mockReset().mockResolvedValue({ data: sources() });
    axios.post.mockReset().mockResolvedValue({ data: {} });
  });

  it("lists the folders with logical size, how long ago, and a link to each history", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("/Users/me")).toBeInTheDocument());

    expect(screen.getByText("Logical size")).toBeInTheDocument();
    expect(screen.getByText("230 GB")).toBeInTheDocument();
    expect(screen.getByText("1 h ago")).toBeInTheDocument();
    expect(screen.getByText("/Users/me").closest("a")).toHaveAttribute(
      "href",
      expect.stringContaining("/snapshots/single-source?userName=me&host=mac&path=%2FUsers%2Fme"),
    );
  });

  it("marks a snapshot that is overdue and shows only the local owner by default", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("/Applications")).toBeInTheDocument());
    expect(screen.getByText("overdue")).toBeInTheDocument();
    expect(screen.queryByText("/Other")).not.toBeInTheDocument();
  });

  it("shows other owners when asked, and remembers the choice", async () => {
    axios.get.mockResolvedValue({ data: sources({ multiUser: true }) });
    const setAll = vi.fn();
    renderPage({ setDefaultSnapshotViewAll: setAll });
    await waitFor(() => expect(screen.getByLabelText("Owner")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "all" } });
    expect(setAll).toHaveBeenCalledWith(true);
    expect(screen.getByText("/Other")).toBeInTheDocument();
    expect(screen.getByText("paused")).toBeInTheDocument();
    expect(screen.getByText("you@mac")).toBeInTheDocument();
  });

  it("shows the failed files of a snapshot and opens them", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("show-snapshot-errors")).toBeInTheDocument());
    expect(screen.getByTestId("show-snapshot-errors")).toHaveTextContent("6 failed");

    fireEvent.click(screen.getByTestId("show-snapshot-errors"));
    expect(screen.getByTestId("snapshot-errors")).toBeInTheDocument();
  });

  it("starts a snapshot", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("snapshot-now").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId("snapshot-now")[0]);
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(expect.stringContaining("/api/v1/sources/upload?"), {}),
    );
  });

  it("shows progress, details and Cancel for a running snapshot", async () => {
    axios.get.mockResolvedValue({
      data: sources({
        sources: [
          {
            source: src("/Users/me"),
            status: "UPLOADING",
            currentTask: "t1",
            upload: { hashedBytes: 1e9, cachedBytes: 1e9, estimatedBytes: 4e9, directory: "/Users/me/x" },
          },
        ],
      }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("snapshot-uploading")).toBeInTheDocument());
    expect(screen.getByText(/2 GB \/ 4 GB 50%/)).toBeInTheDocument();
    expect(screen.getByText("Details")).toHaveAttribute("href", "/tasks/t1");

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(expect.stringContaining("/api/v1/sources/cancel?"), {}),
    );
  });

  it("shows a pending snapshot", async () => {
    axios.get.mockResolvedValue({ data: sources({ sources: [{ source: src("/Users/me"), status: "PENDING" }] }) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("snapshot-pending")).toBeInTheDocument());
  });

  it("says what to do when nothing is backed up, and reports an error from Synchronize", async () => {
    axios.get.mockResolvedValue({ data: sources({ sources: [] }) });
    axios.post.mockRejectedValue({ message: "offline" });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Nothing is backed up yet/)).toBeInTheDocument());
    fireEvent.click(screen.getByText("Synchronize"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not synchronized: offline"));
  });
});

describe("snapshot helpers", () => {
  it("formats upload progress, with a percentage only when the total is known and sensible", () => {
    expect(uploadProgress({ hashedBytes: 1e9, cachedBytes: 0 })).toBe("1 GB");
    expect(uploadProgress({ hashedBytes: 1e9, cachedBytes: 0, estimatedBytes: 4e9 })).toBe("1 GB / 4 GB 25%");
    expect(uploadProgress({ hashedBytes: 5e9, cachedBytes: 0, estimatedBytes: 4e9 })).toBe("5 GB / 4 GB");
    expect(uploadProgress(undefined)).toBe("");
  });

  it("flags a size jump over 25% and 100 MB, either way", () => {
    expect(sizeJump(1.3e12, 205e9)).toBeGreaterThan(1e12);
    expect(sizeJump(100e9, 205e9)).toBeLessThan(0);
    expect(sizeJump(206e9, 205e9)).toBeNull();
    expect(sizeJump(50e6, 10e6)).toBeNull();
    expect(sizeJump(5, 0)).toBeNull();
    expect(sizeJump(undefined, 5)).toBeNull();
  });
});
