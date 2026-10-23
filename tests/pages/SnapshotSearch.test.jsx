import React from "react";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { SnapshotSearch, availableRanges, formatSeenRange, searchRange } from "../../src/pages/SnapshotSearch";
import { UIPreferencesContext } from "../../src/contexts/UIPreferencesContext";

let axiosMock;

const progress = { snapshotsTotal: 3, snapshotsDone: 3, directories: 120, entries: 900 };

const result = (over = {}) => ({
  source: "me@host:/data",
  path: "docs/x.txt",
  name: "x.txt",
  isDir: false,
  size: 2048,
  modTime: "2026-03-01T10:00:00Z",
  objectId: "kabc123",
  firstSeen: "2024-04-03T12:00:00Z",
  lastSeen: "2026-10-20T12:00:00Z",
  snapshotCount: 40,
  ...over,
});

const availability = {
  count: 24,
  first: "2025-03-04T12:00:00Z",
  last: "2026-10-21T12:00:00Z",
  sources: [
    {
      source: "me@host:/Applications",
      path: "/Applications",
      count: 12,
      first: "2025-03-04T12:00:00Z",
      last: "2026-10-21T12:00:00Z",
    },
    {
      source: "me@host:/Users/me",
      path: "/Users/me",
      count: 12,
      first: "2026-10-20T12:00:00Z",
      last: "2026-10-21T12:00:00Z",
    },
  ],
};

const finished = (results, extra = {}) => ({
  id: "s1",
  running: false,
  startedAt: "2026-10-21T10:00:00Z",
  progress,
  results,
  ...extra,
});

function renderPage() {
  return render(
    <UIPreferencesContext value={{ bytesStringBase2: false }}>
      <SnapshotSearch />
    </UIPreferencesContext>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  axiosMock = new MockAdapter(axios);
  axiosMock.onGet("/api/v1/search-range").reply(200, availability);
});

afterEach(() => {
  axiosMock.restore();
});

describe("searchRange", () => {
  const now = new Date(2026, 9, 20, 12, 0, 0); // local time

  test("recency presets start that many days back with no end", () => {
    const r = searchRange("30", "", "", now);
    expect(new Date(r.from).getTime()).toBe(now.getTime() - 30 * 86400000);
    expect(r.to).toBeUndefined();
    expect(new Date(searchRange("5", "", "", now).from).getTime()).toBe(now.getTime() - 5 * 86400000);
    expect(new Date(searchRange("60", "", "", now).from).getTime()).toBe(now.getTime() - 60 * 86400000);
  });

  test("this year starts on January 1st and has no end", () => {
    const r = searchRange("thisYear", "", "", now);
    expect(new Date(r.from).getTime()).toBe(new Date(2026, 0, 1).getTime());
    expect(r.to).toBeUndefined();
  });

  test("last year is the previous calendar year", () => {
    const r = searchRange("lastYear", "", "", now);
    expect(new Date(r.from).getTime()).toBe(new Date(2025, 0, 1).getTime());
    expect(new Date(r.to).getTime()).toBe(new Date(2025, 11, 31, 23, 59, 59, 999).getTime());
  });

  test("all snapshots has no bounds", () => {
    expect(searchRange("all", "", "", now)).toEqual({});
  });

  test("custom range covers whole days and may be open ended", () => {
    const r = searchRange("custom", "2025-04-03", "2025-04-05", now);
    expect(new Date(r.from).getTime()).toBe(new Date("2025-04-03T00:00:00").getTime());
    expect(new Date(r.to).getTime()).toBe(new Date("2025-04-05T23:59:59.999").getTime());
    expect(searchRange("custom", "2025-04-03", "", now).to).toBeUndefined();
    expect(searchRange("custom", "", "", now)).toEqual({});
  });
});

describe("availableRanges", () => {
  const now = new Date(2026, 9, 22, 12, 0, 0);
  const daysAgo = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  const values = (avail) => availableRanges(avail, now).map((r) => r.value);

  test("with a long history offers every preset", () => {
    expect(values({ count: 5000, first: "2025-03-04T12:00:00Z", last: daysAgo(0) })).toEqual([
      "5",
      "30",
      "60",
      "90",
      "thisYear",
      "lastYear",
      "all",
      "custom",
    ]);
  });

  test("leaves out ranges that go back further than the oldest snapshot", () => {
    // oldest snapshot is 2 days old: longer day ranges add nothing, and there is no snapshot from last year
    expect(values({ count: 24, first: daysAgo(2), last: daysAgo(0) })).toEqual(["5", "thisYear", "all", "custom"]);
  });

  test("offers a longer range only when it adds snapshots", () => {
    // 40 days of history: 60 days is the first range that covers it all, 90 would add nothing
    expect(values({ count: 900, first: daysAgo(40), last: daysAgo(0) })).toEqual([
      "5",
      "30",
      "60",
      "thisYear",
      "all",
      "custom",
    ]);
  });

  test("offers this year and last year only when snapshots fall in them", () => {
    const jan = new Date(2026, 0, 10).toISOString();
    expect(values({ count: 9, first: new Date(2025, 5, 1).toISOString(), last: jan })).toContain("lastYear");
    expect(
      values({ count: 9, first: new Date(2024, 5, 1).toISOString(), last: new Date(2024, 8, 1).toISOString() }),
    ).toEqual(["all", "custom"]);
  });

  test("without snapshots only all and custom remain", () => {
    expect(values({ count: 0 })).toEqual(["all", "custom"]);
    expect(values(null)).toEqual(["all", "custom"]);
  });
});

describe("formatSeenRange", () => {
  test("shows first and last date", () => {
    const a = new Date("2024-04-03T12:00:00Z").toLocaleDateString();
    const b = new Date("2026-10-20T12:00:00Z").toLocaleDateString();
    expect(formatSeenRange("2024-04-03T12:00:00Z", "2026-10-20T12:00:00Z")).toBe(a + " - " + b);
  });

  test("shows a single date when both are the same day", () => {
    expect(formatSeenRange("2026-10-20T01:00:00Z", "2026-10-20T02:00:00Z")).not.toContain(" - ");
  });
});

describe("SnapshotSearch page", () => {
  test("starts a search with the pattern and recency, then lists versions with date ranges", async () => {
    let body;
    axiosMock.onPost("/api/v1/search").reply((config) => {
      body = JSON.parse(config.data);
      return [200, { id: "s1" }];
    });
    axiosMock.onGet("/api/v1/search/s1").reply(
      200,
      finished([
        result(),
        result({
          objectId: "kdef456",
          size: 10,
          firstSeen: "2026-10-21T12:00:00Z",
          lastSeen: "2026-10-21T12:00:00Z",
          snapshotCount: 1,
        }),
      ]),
    );

    renderPage();
    await userEvent.type(screen.getByTestId("search-pattern"), "x.txt");
    await userEvent.selectOptions(screen.getByTestId("search-range"), "30");
    await userEvent.click(screen.getByTestId("start-search"));

    await waitFor(() => expect(screen.getAllByTestId("search-result")).toHaveLength(2));

    expect(body.pattern).toBe("x.txt");
    expect(body.includeDirs).toBe(false);
    const days = (Date.now() - new Date(body.from).getTime()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const rows = screen.getAllByTestId("search-result");
    expect(within(rows[0]).getByTestId("seen-range")).toHaveTextContent(
      new Date("2024-04-03T12:00:00Z").toLocaleDateString() +
        " - " +
        new Date("2026-10-20T12:00:00Z").toLocaleDateString(),
    );
    // no snapshot counts, just the dates
    expect(within(rows[0]).getByTestId("seen-range")).not.toHaveTextContent("snapshots");
    expect(within(rows[0]).getByTestId("result-path")).toHaveAttribute("title", "docs/x.txt");
    expect(within(rows[0]).getByText("x.txt")).toBeInTheDocument();
    // a version seen on a single day shows just that date
    expect(within(rows[1]).getByTestId("seen-range")).toHaveTextContent(
      new Date("2026-10-21T12:00:00Z").toLocaleDateString(),
    );
    expect(within(rows[1]).getByTestId("seen-range")).not.toHaveTextContent(" - ");
  });

  test("view and restore links point at the version's object", async () => {
    sessionStorage.setItem("snapshotSearchId", "s1");
    axiosMock
      .onGet("/api/v1/search/s1")
      .reply(200, finished([result(), result({ path: "docs", name: "docs", isDir: true, objectId: "kdir9" })]));

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("search-result")).toHaveLength(2));

    const [file, dir] = screen.getAllByTestId("search-result");
    expect(within(file).getByTestId("view-result")).toHaveAttribute("href", "/api/v1/objects/kabc123?fname=x.txt");
    expect(within(file).getByTestId("restore-result")).toHaveAttribute("href", "/snapshots/dir/kabc123/restore");
    expect(within(dir).getByTestId("view-result")).toHaveAttribute("href", "/snapshots/dir/kdir9");
    expect(within(dir).getByTestId("view-result")).toHaveTextContent("Browse");
    // solid buttons: their labels are visible without hovering
    expect(within(file).getByTestId("view-result")).toHaveClass("btn-primary");
    expect(within(file).getByTestId("restore-result")).toHaveClass("btn-primary");
  });

  test("includes folders when asked and sends custom dates", async () => {
    let body;
    axiosMock.onPost("/api/v1/search").reply((config) => {
      body = JSON.parse(config.data);
      return [200, { id: "s1" }];
    });
    axiosMock.onGet("/api/v1/search/s1").reply(200, finished([]));

    renderPage();
    await userEvent.type(screen.getByTestId("search-pattern"), "docs");
    await userEvent.click(screen.getByLabelText("Also match folder names"));
    await userEvent.selectOptions(screen.getByTestId("search-range"), "custom");
    fireEvent.change(screen.getByTestId("search-from"), { target: { value: "2025-04-03" } });
    fireEvent.change(screen.getByTestId("search-to"), { target: { value: "2025-04-05" } });
    await userEvent.click(screen.getByTestId("start-search"));

    await waitFor(() => expect(body).toBeDefined());
    expect(body.includeDirs).toBe(true);
    expect(new Date(body.from).getTime()).toBe(new Date("2025-04-03T00:00:00").getTime());
    expect(new Date(body.to).getTime()).toBe(new Date("2025-04-05T23:59:59.999").getTime());
    await waitFor(() => expect(screen.getByTestId("no-results")).toBeInTheDocument());
  });

  test("shows progress while running and can cancel", async () => {
    sessionStorage.setItem("snapshotSearchId", "s1");
    let canceled = false;
    axiosMock.onGet("/api/v1/search/s1").reply(() => [
      200,
      canceled
        ? finished([result()], { canceled: true })
        : {
            ...finished([result()]),
            running: true,
            progress: { snapshotsTotal: 30, snapshotsDone: 12, directories: 14203, entries: 1 },
          },
    ]);
    axiosMock.onDelete("/api/v1/search/s1").reply(() => {
      canceled = true;
      return [200, {}];
    });

    renderPage();
    await waitFor(() => expect(screen.getByTestId("search-progress")).toHaveTextContent("snapshot 12 of 30"));
    expect(screen.getByTestId("search-progress")).toHaveTextContent("14,203 folders read");
    expect(screen.getByTestId("search-progress")).toHaveTextContent("1 found");
    expect(screen.queryByTestId("start-search")).toBeNull();

    await userEvent.click(screen.getByTestId("cancel-search"));
    await waitFor(() => expect(screen.getByTestId("search-progress")).toHaveTextContent("Search canceled"));
    expect(screen.getByTestId("start-search")).toBeInTheDocument();
  });

  test("resumes the last search when the page is opened again", async () => {
    sessionStorage.setItem("snapshotSearchId", "s1");
    axiosMock.onGet("/api/v1/search/s1").reply(200, finished([result()]));

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("search-result")).toHaveLength(1));
  });

  test("has a Clear button that removes the results and keeps the search form", async () => {
    sessionStorage.setItem("snapshotSearchId", "s1");
    axiosMock.onGet("/api/v1/search/s1").reply(200, finished([result()]));
    axiosMock.onDelete("/api/v1/search/s1").reply(200, {});

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("search-result")).toHaveLength(1));
    await userEvent.type(screen.getByTestId("search-pattern"), "report*");

    await userEvent.click(screen.getByTestId("clear-results"));

    await waitFor(() => expect(screen.queryByTestId("search-results")).toBeNull());
    expect(screen.queryByTestId("search-progress")).toBeNull();
    expect(screen.queryByTestId("clear-results")).toBeNull();
    expect(sessionStorage.getItem("snapshotSearchId")).toBeNull();
    expect(axiosMock.history.delete.map((d) => d.url)).toEqual(["/api/v1/search/s1"]);
    expect(screen.getByTestId("search-pattern")).toHaveValue("report*"); // the form stays, ready to search again
    expect(screen.getByTestId("start-search")).toBeInTheDocument();
  });

  test("Clear also appears with no matches or an error, but not while searching", async () => {
    sessionStorage.setItem("snapshotSearchId", "s1");
    axiosMock.onGet("/api/v1/search/s1").reply(200, finished([]));

    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getByTestId("no-results")).toBeInTheDocument());
    expect(screen.getByTestId("clear-results")).toBeInTheDocument();
    unmount();

    axiosMock.reset();
    axiosMock.onGet("/api/v1/search-range").reply(200, { count: 0, sources: [] });
    axiosMock.onGet("/api/v1/search/s1").reply(200, {
      ...finished([result()]),
      running: true,
      progress: { snapshotsTotal: 30, snapshotsDone: 12, directories: 1, entries: 1 },
    });

    renderPage();
    await waitFor(() => expect(screen.getByTestId("search-progress")).toHaveTextContent("snapshot 12 of 30"));
    expect(screen.queryByTestId("clear-results")).toBeNull();
  });

  test("forgets a search the server no longer knows", async () => {
    sessionStorage.setItem("snapshotSearchId", "gone");
    axiosMock.onGet("/api/v1/search/gone").reply(404, { code: "NOT_FOUND", error: "search not found" });

    renderPage();
    await waitFor(() => expect(sessionStorage.getItem("snapshotSearchId")).toBeNull());
    expect(screen.queryByTestId("search-results")).toBeNull();
  });

  test("warns when results were truncated and shows server errors", async () => {
    sessionStorage.setItem("snapshotSearchId", "s1");
    axiosMock.onGet("/api/v1/search/s1").reply(200, finished([result()], { truncated: true, error: "boom" }));

    renderPage();
    await waitFor(() => expect(screen.getByText(/Too many matches/)).toBeInTheDocument());
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  test("does not start a search without a pattern", async () => {
    let posted = false;
    axiosMock.onPost("/api/v1/search").reply(() => {
      posted = true;
      return [200, { id: "s1" }];
    });

    renderPage();
    await userEvent.click(screen.getByTestId("start-search"));
    expect(posted).toBe(false);
  });

  test("shows the snapshots that exist as a small table, overall and per source", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId("available-snapshots")).toBeInTheDocument());
    const d = (iso) => new Date(iso).toLocaleDateString();

    const all = screen.getByTestId("available-all");
    expect(all).toHaveTextContent("All sources");
    expect(all).toHaveTextContent(d("2025-03-04T12:00:00Z"));
    expect(all).toHaveTextContent(d("2026-10-21T12:00:00Z"));
    expect(all).toHaveTextContent("24");

    const [apps, home] = screen.getAllByTestId("available-source");
    expect(apps).toHaveTextContent("/Applications");
    expect(apps).toHaveTextContent(d("2025-03-04T12:00:00Z"));
    expect(apps).toHaveTextContent("12");
    expect(home).toHaveTextContent("/Users/me");
    expect(home).toHaveTextContent(d("2026-10-20T12:00:00Z"));
  });

  test("a single source has no separate total row", async () => {
    axiosMock
      .onGet("/api/v1/search-range")
      .reply(200, { ...availability, count: 12, sources: [availability.sources[0]] });

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("available-source")).toHaveLength(1));
    expect(screen.queryByTestId("available-all")).toBeNull();
  });

  test("says so when there are no snapshots yet", async () => {
    axiosMock
      .onGet("/api/v1/search-range")
      .reply(200, { count: 0, first: "0001-01-01T00:00:00Z", last: "0001-01-01T00:00:00Z", sources: [] });

    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("available-snapshots")).toHaveTextContent("no snapshots to search yet"),
    );
  });

  test("keeps the search tips folded away until asked for", async () => {
    renderPage();
    const tips = screen.getByTestId("search-tips");
    expect(tips).not.toHaveAttribute("open");
    expect(tips).toHaveTextContent("Search tips");
    expect(tips.querySelector("summary")).toBeInTheDocument();
  });

  test("custom dates cannot go outside the available snapshots", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("available-snapshots")).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByTestId("search-range"), "custom");
    const d = (iso) => {
      const x = new Date(iso);
      return [x.getFullYear(), String(x.getMonth() + 1).padStart(2, "0"), String(x.getDate()).padStart(2, "0")].join(
        "-",
      );
    };
    expect(screen.getByTestId("search-from")).toHaveAttribute("min", d("2025-03-04T12:00:00Z"));
    expect(screen.getByTestId("search-from")).toHaveAttribute("max", d("2026-10-21T12:00:00Z"));
    expect(screen.getByTestId("search-to")).toHaveAttribute("min", d("2025-03-04T12:00:00Z"));
  });

  test("only offers ranges that make sense for the snapshots that exist", async () => {
    axiosMock
      .onGet("/api/v1/search-range")
      .reply(200, { count: 3, first: new Date().toISOString(), last: new Date().toISOString(), sources: [] });

    renderPage();
    await waitFor(() => expect(screen.getByTestId("available-snapshots")).toBeInTheDocument());

    const labels = within(screen.getByTestId("search-range"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toEqual(["Last 5 days", "This year", "All snapshots", "Custom range..."]);
  });

  test("shows long folder paths shortened but keeps the file name and the full path as a tooltip", async () => {
    sessionStorage.setItem("snapshotSearchId", "s1");
    const longPath =
      "Library/Mail/V10/234D2655-A07A-46ED-9B0E-23FDB1EACE2B/Data/6/1/Attachments/16577/2/investments.xlsx";
    axiosMock.onGet("/api/v1/search/s1").reply(200, finished([result({ path: longPath, name: "investments.xlsx" })]));

    renderPage();
    await waitFor(() => expect(screen.getByTestId("result-path")).toBeInTheDocument());

    const cell = screen.getByTestId("result-path");
    expect(cell).toHaveAttribute("title", longPath);
    expect(within(cell).getByText("investments.xlsx")).toBeInTheDocument();
    expect(
      within(cell).getByText("Library/Mail/V10/234D2655-A07A-46ED-9B0E-23FDB1EACE2B/Data/6/1/Attachments/16577/2/"),
    ).toHaveStyle({
      textOverflow: "ellipsis",
    });
  });
});
