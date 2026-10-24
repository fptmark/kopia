import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { MemoryRouter } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { SnapshotDiff } from "../../../src/next/pages/SnapshotDiff";

vi.mock("axios");

const response = (over = {}) => ({
  source: { host: "h", userName: "u", path: "/Users/u" },
  from: { id: "aaa", startTime: "2026-10-23T14:01:53Z", summary: { size: 204.8e9 } },
  to: { id: "bbb", startTime: "2026-10-23T17:22:07Z", summary: { size: 230e9 } },
  entries: [
    { path: "docs/new.txt", change: "added", isDir: false, oldSize: 0, newSize: 4000 },
    { path: "old", change: "removed", isDir: true, oldSize: 300, newSize: 0, files: 12 },
    { path: "notes.md", change: "modified", isDir: false, oldSize: 100, newSize: 150 },
  ],
  truncated: false,
  added: 1,
  removed: 12,
  modified: 1,
  addedBytes: 4000,
  removedBytes: 300,
  modifiedDeltaBytes: 50,
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/snapshots/diff?from=aaa&to=bbb"]}>
      <UIPreferencesContext.Provider value={{ pageSize: 25, bytesStringBase2: false }}>
        <SnapshotDiff />
      </UIPreferencesContext.Provider>
    </MemoryRouter>,
  );

const serve = (data) => axios.get.mockResolvedValue({ data });

describe("SnapshotDiff", () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset().mockResolvedValue({ data: { added: [{}, {}], existing: [], changes: [] } });
  });

  it("asks for the two snapshots and shows the totals and the changes", async () => {
    serve(response());
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

    expect(axios.get).toHaveBeenCalledWith("/api/v1/snapshots/diff", { params: { from: "aaa", to: "bbb" } });
    expect(screen.getByText("old/")).toBeInTheDocument();
    const summary = screen.getByTestId("diff-summary");
    expect(summary).toHaveTextContent("1 file");
    expect(summary).toHaveTextContent("12 files");
    expect(summary).toHaveTextContent("+50 B net");
    expect(summary).toHaveTextContent("230 GB");
  });

  it("shows every kind at first, and lets each be switched off", async () => {
    serve(response());
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

    for (const k of ["added", "removed", "modified"]) {
      expect(screen.getByLabelText(k)).toBeChecked();
    }
    fireEvent.click(screen.getByLabelText("added"));
    fireEvent.click(screen.getByLabelText("modified"));
    expect(screen.queryByText("docs/new.txt")).not.toBeInTheDocument();
    expect(screen.getByText("old/")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("added"));
    fireEvent.click(screen.getByLabelText("modified"));
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "notes" } });
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.queryByText("docs/new.txt")).not.toBeInTheDocument();
  });

  it("says when nothing differs, and when the list is cut short", async () => {
    serve(response({ entries: [], added: 0, removed: 0, modified: 0 }));
    renderPage();
    await waitFor(() => expect(screen.getByText("The two snapshots are the same.")).toBeInTheDocument());
  });

  it("notes truncation", async () => {
    serve(response({ truncated: true }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("diff-truncated")).toBeInTheDocument());
  });

  it("shows an error with a way to retry", async () => {
    axios.get.mockRejectedValue({ message: "x", response: { data: { error: "snapshot not found" } } });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("snapshot not found"));
  });

  it("keeps Exclude muted until something is ticked; removed rows cannot be ticked", async () => {
    serve(response());
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

    expect(screen.getByTestId("exclude-selected")).toBeDisabled();
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("Nothing selected");
    expect(screen.queryByLabelText("Select row old")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Select row docs/new.txt"));
    expect(screen.getByTestId("exclude-selected")).toBeEnabled();
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("1 selected (4 KB)");
  });

  it("ticks the page from the header and lists the rest with a link", async () => {
    serve(response());
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Select all on this page"));
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("2 selected");
    fireEvent.click(screen.getByRole("link", { name: "Clear" }));
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("Nothing selected");
  });

  it("adds the ticked paths as rules for the source after confirming", async () => {
    serve(response());
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Select row docs/new.txt"));
    fireEvent.click(screen.getByLabelText("Select row notes.md"));
    fireEvent.click(screen.getByTestId("exclude-selected"));
    expect(axios.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("exclude-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("/api/v1/exclusions", {
        rules: [
          { source: "/Users/u", pattern: "/docs/new.txt" },
          { source: "/Users/u", pattern: "/notes.md" },
        ],
        addedBy: "compare",
      }),
    );
    await waitFor(() => expect(screen.getByText(/Added 2 rules/)).toBeInTheDocument());
  });

  it("offers one rule by name for folders that share a name, and can turn it off", async () => {
    serve(
      response({
        entries: [
          { path: "a/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 900, files: 5 },
          { path: "b/c/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 800, files: 4 },
          { path: "Caches", change: "added", isDir: true, oldSize: 0, newSize: 700, files: 3 },
          { path: "x.log", change: "added", isDir: false, oldSize: 0, newSize: 10 },
        ],
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("a/node_modules/")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Select all on this page"));
    fireEvent.click(screen.getByTestId("exclude-selected"));
    expect(screen.getByLabelText(/Every folder named node_modules/)).toBeChecked();
    expect(screen.getByLabelText(/Every folder named Caches/)).not.toBeChecked();

    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(axios.post.mock.calls[0][1].rules.map((r) => r.pattern)).toEqual(["node_modules/", "/Caches", "/x.log"]);
  });

  it("turns the by-name rule off to exclude exact paths", async () => {
    serve(
      response({
        entries: [
          { path: "a/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 900, files: 5 },
          { path: "b/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 800, files: 4 },
        ],
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("a/node_modules/")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all on this page"));
    fireEvent.click(screen.getByTestId("exclude-selected"));
    fireEvent.click(screen.getByLabelText(/Every folder named node_modules/));
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(axios.post.mock.calls[0][1].rules.map((r) => r.pattern)).toEqual(["/a/node_modules", "/b/node_modules"]);
  });

  it("reports a rule that was saved but not applied", async () => {
    serve(response());
    axios.post.mockResolvedValue({ data: { added: [{}], existing: [], changes: [], applyError: "policy is locked" } });
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select row docs/new.txt"));
    fireEvent.click(screen.getByTestId("exclude-selected"));
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(screen.getByText(/policy was not updated: policy is locked/)).toBeInTheDocument());
  });

  it("reports a refused request", async () => {
    serve(response());
    axios.post.mockRejectedValue({ message: "x", response: { data: { message: "a pattern cannot start with #" } } });
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select row docs/new.txt"));
    fireEvent.click(screen.getByTestId("exclude-selected"));
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Not changed: a pattern cannot start with #"),
    );
  });
});
