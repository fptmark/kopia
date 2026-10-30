import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { RouterProvider, createMemoryRouter } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { Files } from "../../../src/next/pages/Files";
import { availableRanges, formatSeenRange, resultLinks, searchRange } from "../../../src/next/search";

vi.mock("axios");

const avail = {
  count: 40,
  first: "2026-10-01T00:00:00Z",
  last: new Date().toISOString(),
  sources: [
    { source: "u@h:/a", path: "/a", first: "2026-10-01T00:00:00Z", last: "2026-10-23T00:00:00Z", count: 30 },
    { source: "u@h:/b", path: "/b", first: "2026-10-05T00:00:00Z", last: "2026-10-23T00:00:00Z", count: 10 },
  ],
};

const result = (over = {}) => ({
  source: "/a",
  path: "Documents/report.xls",
  name: "report.xls",
  objectId: "obj1",
  isDir: false,
  size: 5000,
  modTime: "2026-10-20T10:00:00Z",
  firstSeen: "2026-10-01T10:00:00Z",
  lastSeen: "2026-10-23T10:00:00Z",
  ...over,
});

const progress = { snapshotsDone: 5, snapshotsTotal: 5, directories: 1200 };

const renderPage = () => {
  const router = createMemoryRouter([{ path: "*", element: <Files /> }]);
  return render(
    <UIPreferencesContext.Provider value={{ pageSize: 25, bytesStringBase2: false }}>
      <RouterProvider router={router} />
    </UIPreferencesContext.Provider>,
  );
};

describe("Files page", () => {
  beforeEach(() => {
    sessionStorage.clear();
    axios.get
      .mockReset()
      .mockImplementation((url) =>
        url === "/api/v1/search-range" ? Promise.resolve({ data: avail }) : Promise.reject(new Error("unknown " + url)),
      );
    axios.post.mockReset().mockResolvedValue({ data: { id: "s1" } });
    axios.delete.mockReset().mockResolvedValue({ data: {} });
  });

  it("shows which snapshots can be searched", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("available-snapshots")).toHaveTextContent("All sources"));
    expect(screen.getByTestId("available-snapshots")).toHaveTextContent("/a");
    expect(screen.getByTestId("available-snapshots")).toHaveTextContent("/b");
  });

  it("needs a name before it searches, then starts a search over the chosen range", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("start-search")).toBeDisabled());

    fireEvent.change(screen.getByTestId("search-pattern"), { target: { value: "report*" } });
    fireEvent.click(screen.getByLabelText("Also match folder names"));
    fireEvent.click(screen.getByTestId("start-search"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(
        "/api/v1/search",
        expect.objectContaining({ pattern: "report*", includeDirs: true, from: expect.any(String) }),
      ),
    );
  });

  it("lists results with actions, and the source column only when there are several", async () => {
    sessionStorage.setItem("nextSearchId", "s1");
    axios.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/v1/search-range"
            ? avail
            : {
                running: false,
                progress,
                results: [
                  result(),
                  result({ source: "/b", path: "Pictures", name: "Pictures", objectId: "obj2", isDir: true }),
                ],
              },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("result-path")).toHaveLength(2));

    expect(screen.getByTestId("search-progress")).toHaveTextContent("2 results in 5 of 5 snapshots");
    expect(within(screen.getByRole("table", { name: "search results" })).getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("5 kB".replace("k", "K"))).toBeInTheDocument();
    expect(screen.getAllByTestId("view-result")[0]).toHaveTextContent(/Browse|View/);
    const restores = screen.getAllByTestId("restore-result");
    expect(restores.map((a) => a.getAttribute("href")).sort()).toEqual([
      "/snapshots/dir/obj1/restore",
      "/snapshots/dir/obj2/restore",
    ]);
  });

  it("says when nothing matched, and clears the results", async () => {
    sessionStorage.setItem("nextSearchId", "s1");
    axios.get.mockImplementation((url) =>
      Promise.resolve({ data: url === "/api/v1/search-range" ? avail : { running: false, progress, results: [] } }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId("no-results")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("clear-results"));
    await waitFor(() => expect(screen.queryByTestId("search-progress")).not.toBeInTheDocument());
    expect(axios.delete).toHaveBeenCalledWith("/api/v1/search/s1");
    expect(sessionStorage.getItem("nextSearchId")).toBeNull();
  });

  it("shows progress while a search runs, with Cancel", async () => {
    sessionStorage.setItem("nextSearchId", "s1");
    axios.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/v1/search-range"
            ? avail
            : { running: true, progress: { snapshotsDone: 2, snapshotsTotal: 5, directories: 40 }, results: [] },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId("search-progress")).toHaveTextContent("snapshot 2 of 5"));
    fireEvent.click(screen.getByTestId("cancel-search"));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith("/api/v1/search/s1"));
  });

  it("warns when there are too many matches, and shows a search error", async () => {
    sessionStorage.setItem("nextSearchId", "s1");
    axios.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/v1/search-range"
            ? avail
            : { running: false, progress, truncated: true, error: "out of memory", results: [result()] },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/Too many matches/)).toBeInTheDocument());
    expect(screen.getByText("out of memory")).toBeInTheDocument();
  });

  it("drops a search the server no longer knows", async () => {
    sessionStorage.setItem("nextSearchId", "gone");
    axios.get.mockImplementation((url) =>
      url === "/api/v1/search-range" ? Promise.resolve({ data: avail }) : Promise.reject({ response: { status: 404 } }),
    );
    renderPage();
    await waitFor(() => expect(sessionStorage.getItem("nextSearchId")).toBeNull());
  });

  it("explains a refused search", async () => {
    axios.post.mockRejectedValue({ message: "x", response: { data: { message: "bad pattern" } } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("search-pattern")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("search-pattern"), { target: { value: "[" } });
    fireEvent.click(screen.getByTestId("start-search"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unable to start the search: bad pattern"));
  });
});

describe("search helpers", () => {
  const now = new Date("2026-10-23T12:00:00");

  it("builds the time range", () => {
    expect(searchRange("all", "", "", now)).toEqual({});
    expect(new Date(searchRange("30", "", "", now).from).getTime()).toBe(now.getTime() - 30 * 86400e3);
    expect(searchRange("thisYear", "", "", now).from).toBe(new Date(2026, 0, 1).toISOString());
    expect(searchRange("lastYear", "", "", now)).toEqual({
      from: new Date(2025, 0, 1).toISOString(),
      to: new Date(2025, 11, 31, 23, 59, 59, 999).toISOString(),
    });
    expect(searchRange("custom", "2026-10-01", "", now)).toEqual({
      from: new Date("2026-10-01T00:00:00").toISOString(),
    });
  });

  it("offers only ranges that add something", () => {
    const values = (a) => availableRanges(a, now).map((r) => r.value);
    expect(values(null)).toEqual(["all", "custom"]);
    expect(values({ count: 5, first: "2026-10-20T00:00:00Z", last: "2026-10-23T00:00:00Z" })).toEqual([
      "5",
      "thisYear",
      "all",
      "custom",
    ]);
    expect(values({ count: 5, first: "2026-06-01T00:00:00Z", last: "2026-10-23T00:00:00Z" })).toEqual([
      "5",
      "30",
      "60",
      "90",
      "thisYear",
      "all",
      "custom",
    ]);
  });

  it("formats when a version was seen, and links results", () => {
    expect(formatSeenRange("2026-10-01T10:00:00", "2026-10-01T20:00:00")).toBe(
      new Date("2026-10-01T10:00:00").toLocaleDateString(),
    );
    expect(formatSeenRange("2026-10-01T10:00:00", "2026-10-05T10:00:00")).toContain(" - ");
    expect(resultLinks({ isDir: true, objectId: "k1", name: "d" })).toEqual({
      view: "/snapshots/dir/k1",
      viewIsPage: true,
      restore: "/snapshots/dir/k1/restore",
    });
    expect(resultLinks({ isDir: false, objectId: "o", name: "a b.txt" }).view).toBe(
      "/api/v1/objects/o?fname=a%20b.txt",
    );
  });
});
