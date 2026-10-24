import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { SnapshotHistory } from "../../../src/next/pages/SnapshotHistory";

vi.mock("axios");

const snap = (id, startTime, size, extra = {}) => ({
  id,
  startTime,
  rootID: "k" + id,
  summary: { size, files: 1311967, dirs: 212832 },
  retention: ["latest-1"],
  pins: [],
  ...extra,
});

const history = (snapshots, over = {}) => ({
  snapshots,
  unfilteredCount: snapshots.length,
  uniqueCount: snapshots.length,
  ...over,
});

const THREE = [
  snap("s3", "2026-10-23T17:22:07Z", 230e9),
  snap("s2", "2026-10-23T14:01:53Z", 204.8e9, { description: "before the cleanup", pins: ["keep"] }),
  snap("s1", "2026-10-22T09:00:00Z", 1.3e12),
];

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function serve({ list = history(THREE), stats = { snapshots: [] } } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.startsWith("/api/v1/snapshots/storage-stats")) {
      return stats instanceof Error ? Promise.reject(stats) : Promise.resolve({ data: stats });
    }
    return Promise.resolve({ data: list });
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/snapshots/single-source?userName=me&host=mac&path=%2FUsers%2Fme"]}>
      <UIPreferencesContext.Provider value={{ pageSize: 25, bytesStringBase2: false }}>
        <Routes>
          <Route path="/snapshots/single-source" element={<SnapshotHistory />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </UIPreferencesContext.Provider>
    </MemoryRouter>,
  );

const box = (id) => screen.getByLabelText("Select row " + id);

describe("SnapshotHistory", () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset().mockResolvedValue({ data: {} });
  });

  it("shows the totals and one row per snapshot, newest first", async () => {
    serve({
      stats: {
        snapshots: [
          { id: "s1", newBytes: 150e9, newFiles: 600000, newDirs: 100 },
          { id: "s2", newBytes: 5e6, newFiles: 3, newDirs: 1 },
          { id: "s3", newBytes: 7e6, newFiles: 4, newDirs: 2 },
        ],
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("history-summary")).toHaveTextContent("Snapshots3"));

    expect(screen.getByTestId("history-summary")).toHaveTextContent("Newest230 GB");
    await waitFor(() => expect(screen.getByTestId("history-summary")).toHaveTextContent("150 GB"));
    expect(screen.getByText("before the cleanup")).toBeInTheDocument();
    expect(screen.getAllByText("1.3M").length).toBe(3);
    expect(screen.getByText("pin: keep")).toBeInTheDocument();

    const dates = screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/snapshots/dir/"));
    expect(dates.map((a) => a.getAttribute("href"))).toEqual([
      "/snapshots/dir/ks3",
      "/snapshots/dir/ks2",
      "/snapshots/dir/ks1",
    ]);
  });

  it("fills in New data after the list, with the counts on hover", async () => {
    serve({ stats: { snapshots: [{ id: "s3", newBytes: 7e6, newFiles: 4, newDirs: 2 }] } });
    renderPage();
    await waitFor(() => expect(screen.getByTitle("4 new files, 2 new folders")).toBeInTheDocument());
  });

  it("keeps the list when the storage stats cannot be loaded", async () => {
    serve({ stats: new Error("boom") });
    renderPage();
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3));
    expect(screen.getByText("before the cleanup")).toBeInTheDocument();
  });

  it("marks a large change in logical size against the previous snapshot", async () => {
    serve();
    renderPage();
    // the 1.3 TB snapshot is the oldest, so the one after it is the change: 1.1 TB smaller
    await waitFor(() => expect(screen.getAllByTestId("size-jump")).toHaveLength(1));
    expect(screen.getByTestId("size-jump").textContent).toContain("-1.1 TB");
  });

  it("keeps Delete and Compare visible but muted until the selection allows them", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByText("Compare")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();

    fireEvent.click(box("s3"));
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();

    fireEvent.click(box("s1"));
    expect(screen.getByRole("button", { name: "Compare" })).toBeEnabled();
  });

  it("opens the compare page with the older snapshot first", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByText("Compare")).toBeInTheDocument());
    fireEvent.click(box("s3"));
    fireEvent.click(box("s2"));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/snapshots/diff?from=s2&to=s3");
  });

  it("deletes the selected snapshots after confirming", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByText("Compare")).toBeInTheDocument());
    fireEvent.click(box("s1"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(within(screen.getByRole("dialog")).getByText(/selected snapshot/)).toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("/api/v1/snapshots/delete", {
        source: { host: "mac", userName: "me", path: "/Users/me" },
        snapshotManifestIds: ["s1"],
        deleteSourceAndPolicy: false,
      }),
    );
    await waitFor(() => expect(screen.getByText(/Deleted 1 snapshot/)).toBeInTheDocument());
  });

  it("offers to remove the whole folder when every snapshot is selected", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByText("Compare")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all on this page"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByLabelText("Also remove this folder and its policy."));
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.post.mock.calls[0][1].deleteSourceAndPolicy).toBe(true));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/snapshots"));
  });

  it("edits a note and a pin", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByText("Compare")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Note for s3"));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "after cleanup" } });
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("/api/v1/snapshots/edit", {
        snapshots: ["s3"],
        description: "after cleanup",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Pin s3"));
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("/api/v1/snapshots/edit", {
        snapshots: ["s3"],
        addPins: ["do-not-delete"],
        removePins: [],
      }),
    );
  });

  it("asks for identical snapshots when there are some", async () => {
    serve({ list: history(THREE, { unfilteredCount: 41, uniqueCount: 3 }) });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Identical snapshots too \(41\)/)).toBeEnabled());
    fireEvent.click(screen.getByLabelText(/Identical snapshots too/));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining("&all=1")));
  });

  it("lets an empty folder be removed", async () => {
    serve({ list: history([]) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("delete-source")).toBeInTheDocument());
    expect(screen.getByText("This folder has no snapshots.")).toBeInTheDocument();
  });
});
