import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SnapshotDiff } from "../../src/pages/SnapshotDiff";
import { BrowserRouter } from "react-router";
import axios from "axios";
import { UIPreferencesContext } from "../../src/contexts/UIPreferencesContext";
import { resetRouterMocks } from "../testutils/react-router-mock.jsx";

vi.mock("axios");

const policyUrl = (url) => url.startsWith("/api/v1/policy?");

vi.mock("react-router", async () => {
  const { createRouterMock } = await import("../testutils/react-router-mock.jsx");
  return createRouterMock({ location: { search: "?from=aaa&to=bbb" } })();
});

const renderPage = () =>
  render(
    <BrowserRouter>
      <UIPreferencesContext.Provider value={{ pageSize: 20, bytesStringBase2: false }}>
        <SnapshotDiff />
      </UIPreferencesContext.Provider>
    </BrowserRouter>,
  );

const response = (over = {}) => ({
  data: {
    source: { host: "h", userName: "u", path: "/Users/u" },
    from: { id: "aaa", startTime: "2023-01-01T12:00:00Z", summary: { size: 1000 } },
    to: { id: "bbb", startTime: "2023-01-02T12:00:00Z", summary: { size: 5000 } },
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
  },
});

describe("SnapshotDiff", () => {
  beforeEach(() => {
    resetRouterMocks();
    axios.get.mockReset();
  });

  it("requests the diff for the two snapshots and lists the changes", async () => {
    axios.get.mockResolvedValue(response());
    renderPage();

    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

    expect(axios.get).toHaveBeenCalledWith("/api/v1/snapshots/diff?from=aaa&to=bbb");
    expect(screen.getByText("old/")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("1 added");
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("12 removed");
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("+50");
  });

  it("shows every kind of change at first and lets each kind be switched off", async () => {
    axios.get.mockResolvedValue(response());
    renderPage();
    await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

    for (const k of ["added", "removed", "modified"]) {
      expect(screen.getByLabelText(k)).toBeChecked();
    }
    expect(screen.queryByLabelText("all")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("added"));
    fireEvent.click(screen.getByLabelText("modified"));
    expect(screen.queryByText("docs/new.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("notes.md")).not.toBeInTheDocument();
    expect(screen.getByText("old/")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("added"));
    fireEvent.click(screen.getByLabelText("modified"));
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "notes" } });
    expect(screen.queryByText("docs/new.txt")).not.toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });

  it("says when nothing differs and when the list is cut short", async () => {
    axios.get.mockResolvedValue(response({ entries: [], added: 0, removed: 0, modified: 0 }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("diff-summary")).toHaveTextContent("No differences."));
  });

  it("notes truncation", async () => {
    axios.get.mockResolvedValue(response({ truncated: true }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("diff-truncated")).toBeInTheDocument());
  });

  it("shows the server's message when the request fails", async () => {
    axios.get.mockRejectedValue({ message: "boom", response: { data: { error: "snapshot not found" } } });
    renderPage();
    await waitFor(() => expect(screen.getByText("snapshot not found")).toBeInTheDocument());
  });

  describe("select and exclude", () => {
    const mockServer = (policy = {}) => {
      axios.get.mockImplementation((url) =>
        policyUrl(url) ? Promise.resolve({ data: policy }) : Promise.resolve(response()),
      );
      axios.put.mockReset();
      axios.put.mockResolvedValue({ data: {} });
    };

    it("keeps Exclude muted until something is ticked, and removed rows cannot be ticked", async () => {
      mockServer();
      renderPage();
      await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

      expect(screen.getByTestId("exclude-selected")).toBeDisabled();
      expect(screen.queryByLabelText("Select old")).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText("Select docs/new.txt"));
      expect(screen.getByTestId("exclude-selected")).toBeEnabled();
      expect(screen.getByTestId("selection-bar")).toHaveTextContent("1 selected");
    });

    it("adds the ticked paths to the source policy in one save", async () => {
      mockServer({ files: { ignore: ["/already"] } });
      renderPage();
      await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Select docs/new.txt"));
      fireEvent.click(screen.getByLabelText("Select notes.md"));
      fireEvent.click(screen.getByTestId("exclude-selected"));

      expect(screen.getByTestId("exclude-dialog")).toHaveTextContent("these 2 paths");
      fireEvent.click(screen.getByTestId("exclude-confirm"));

      await waitFor(() => expect(screen.getByTestId("exclude-result")).toHaveTextContent("Excluded 2 paths"));

      expect(axios.put).toHaveBeenCalledTimes(1);
      const [url, body] = axios.put.mock.calls[0];
      expect(url).toContain("host=h");
      expect(url).toContain("userName=u");
      expect(body.files.ignore).toEqual(["/already", "/docs/new.txt", "/notes.md"]);
      expect(screen.getByTestId("exclude-selected")).toBeDisabled();
    });

    it("selects and clears the rows on the page from the header checkbox", async () => {
      mockServer();
      renderPage();
      await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

      const header = screen.getByLabelText("Select all on this page");
      fireEvent.click(header);
      // the removed row cannot be excluded, so two of the three rows are selected
      expect(screen.getByTestId("selection-bar")).toHaveTextContent("2 selected");
      expect(header).toBeChecked();

      fireEvent.click(screen.getByLabelText("Select all on this page"));
      expect(screen.getByTestId("selection-bar")).toHaveTextContent("Nothing selected");
    });

    it("shows a partly ticked page as indeterminate and can clear everything", async () => {
      mockServer();
      renderPage();
      await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Select docs/new.txt"));
      expect(screen.getByLabelText("Select all on this page").indeterminate).toBe(true);

      fireEvent.click(screen.getByRole("link", { name: "Clear" }));
      expect(screen.getByTestId("selection-bar")).toHaveTextContent("Nothing selected");
    });

    it("shows the snapshot root the paths are relative to", async () => {
      mockServer();
      renderPage();
      await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

      expect(screen.getByTestId("diff-root")).toHaveTextContent("/Users/u");
      expect(screen.getByTestId("diff-root")).toHaveTextContent("relative to it");
    });

    it("offers to exclude folders that share a name by name, at any depth", async () => {
      axios.get.mockImplementation((url) =>
        policyUrl(url)
          ? Promise.resolve({ data: {} })
          : Promise.resolve(
              response({
                entries: [
                  { path: "a/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 900, files: 5 },
                  { path: "b/c/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 800, files: 4 },
                  { path: "Caches", change: "added", isDir: true, oldSize: 0, newSize: 700, files: 3 },
                  { path: "x.log", change: "added", isDir: false, oldSize: 0, newSize: 10 },
                ],
              }),
            ),
      );
      axios.put.mockReset();
      axios.put.mockResolvedValue({ data: {} });
      renderPage();
      await waitFor(() => expect(screen.getByText("a/node_modules/")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Select all on this page"));
      fireEvent.click(screen.getByTestId("exclude-selected"));

      // two node_modules folders are selected, so they default to one by-name rule; the others stay exact
      expect(screen.getByLabelText(/Every folder named node_modules/)).toBeChecked();
      expect(screen.getByLabelText(/Every folder named Caches/)).not.toBeChecked();

      fireEvent.click(screen.getByTestId("exclude-confirm"));
      await waitFor(() => expect(screen.getByTestId("exclude-result")).toHaveTextContent("Excluded 3 paths"));

      expect(axios.put.mock.calls[0][1].files.ignore).toEqual(["node_modules/", "/Caches", "/x.log"]);
    });

    it("lets the by-name rule be turned off", async () => {
      axios.get.mockImplementation((url) =>
        policyUrl(url)
          ? Promise.resolve({ data: {} })
          : Promise.resolve(
              response({
                entries: [
                  { path: "a/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 900, files: 5 },
                  { path: "b/node_modules", change: "added", isDir: true, oldSize: 0, newSize: 800, files: 4 },
                ],
              }),
            ),
      );
      axios.put.mockReset();
      axios.put.mockResolvedValue({ data: {} });
      renderPage();
      await waitFor(() => expect(screen.getByText("a/node_modules/")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Select all on this page"));
      fireEvent.click(screen.getByTestId("exclude-selected"));
      fireEvent.click(screen.getByLabelText(/Every folder named node_modules/));
      fireEvent.click(screen.getByTestId("exclude-confirm"));

      await waitFor(() => expect(axios.put).toHaveBeenCalled());
      expect(axios.put.mock.calls[0][1].files.ignore).toEqual(["/a/node_modules", "/b/node_modules"]);
    });

    it("reports a failed save", async () => {
      mockServer();
      axios.put.mockRejectedValue({ message: "nope", response: { data: { message: "policy is locked" } } });
      renderPage();
      await waitFor(() => expect(screen.getByText("docs/new.txt")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Select notes.md"));
      fireEvent.click(screen.getByTestId("exclude-selected"));
      fireEvent.click(screen.getByTestId("exclude-confirm"));

      await waitFor(() => expect(screen.getByTestId("exclude-result")).toHaveTextContent("policy is locked"));
    });
  });
});
