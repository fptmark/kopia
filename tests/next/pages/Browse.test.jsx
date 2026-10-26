import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { SnapshotDirectory } from "../../../src/next/pages/SnapshotDirectory";
import { SnapshotRestore } from "../../../src/next/pages/SnapshotRestore";
import { entryLink, entrySize, restoreRequest, RESTORE_DEFAULTS } from "../../../src/next/browse";

vi.mock("axios");

const entries = [
  { name: "b.txt", type: "f", obj: "o1", mtime: "2026-10-20T10:00:00Z", size: 2048 },
  { name: "Docs", type: "d", obj: "kdocs", mtime: "2026-10-21T10:00:00Z", summ: { size: 5e6, files: 12, dirs: 2 } },
  {
    name: "Bad",
    type: "d",
    obj: "kbad",
    mtime: "2026-10-21T10:00:00Z",
    summ: { size: 100, files: 1, dirs: 0, numFailed: 2, errors: [{ path: "x", error: "denied" }] },
  },
];

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

const renderBrowse = (state) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: "/snapshots/dir/kroot", state }]}>
      <UIPreferencesContext.Provider value={{ pageSize: 25, bytesStringBase2: false }}>
        <Routes>
          <Route path="/snapshots/dir/:oid" element={<SnapshotDirectory />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </UIPreferencesContext.Provider>
    </MemoryRouter>,
  );

describe("SnapshotDirectory", () => {
  beforeEach(() => {
    axios.get
      .mockReset()
      .mockImplementation((url) =>
        url.startsWith("/api/v1/mounts/")
          ? Promise.reject({ response: { status: 404 } })
          : Promise.resolve({ data: { entries } }),
      );
    axios.post.mockReset();
    axios.delete.mockReset();
  });

  it("says which snapshot is open and what changed since the one before it", async () => {
    axios.get.mockImplementation((url) =>
      url.startsWith("/api/v1/mounts/")
        ? Promise.reject({ response: { status: 404 } })
        : url.startsWith("/api/v1/snapshots/diff")
          ? Promise.resolve({ data: { added: 3, modified: 12, removed: 1 } })
          : Promise.resolve({ data: { entries } }),
    );
    renderBrowse({
      snapshot: {
        id: "s2",
        previousId: "s1",
        source: { path: "/Users/me" },
        startTime: "2026-10-26T14:00:00Z",
        summary: { size: 2048 },
      },
    });
    await waitFor(() => expect(screen.getByTestId("snapshot-facts")).toHaveTextContent("Files Added: 3"));
    const facts = screen.getByTestId("snapshot-facts");
    expect(facts).toHaveTextContent("Volume: /Users/me");
    expect(facts).toHaveTextContent(/Date: \w+day, October 26, 2026 at/);
    expect(facts).toHaveTextContent("Modified: 12");
    expect(facts).toHaveTextContent("Deleted: 1");
    expect(axios.get).toHaveBeenCalledWith("/api/v1/snapshots/diff", { params: { from: "s1", to: "s2" } });
  });

  it("lists folders first, links folders to the browser and files to a download", async () => {
    renderBrowse();
    await waitFor(() => expect(screen.getByText("Docs/")).toBeInTheDocument());

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Bad/");
    expect(rows[1]).toHaveTextContent("Docs/");
    expect(rows[2]).toHaveTextContent("b.txt");
    expect(screen.getByText("Docs/").closest("a")).toHaveAttribute("href", "/snapshots/dir/kdocs");
    expect(screen.getByText("b.txt").closest("a")).toHaveAttribute("href", "/api/v1/objects/o1?fname=b.txt");
    expect(screen.getByText("5 MB")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
  });

  it("shows the failed files of a folder", async () => {
    renderBrowse();
    await waitFor(() => expect(screen.getByTestId("show-snapshot-errors")).toHaveTextContent("2 failed"));
  });

  it("shows the trail that led here, each step a link back", async () => {
    renderBrowse({
      label: "Docs",
      oid: "kroot",
      snapshot: {
        id: "s2",
        source: { host: "mac", userName: "me", path: "/Users/me" },
        startTime: "2026-10-26T14:00:00Z",
      },
      prevState: {
        label: "/Users/me",
        snapshot: { id: "s2", rootID: "kbase", source: { host: "mac", userName: "me", path: "/Users/me" } },
      },
    });
    await waitFor(() => expect(screen.getByRole("link", { name: "/Users/me" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Volumes" })).toHaveAttribute("href", "/snapshots");
    expect(screen.getByRole("link", { name: "History" }).getAttribute("href")).toMatch(/^\/snapshots\/single-source\?/);
    expect(screen.getByRole("link", { name: "/Users/me" })).toHaveAttribute("href", "/snapshots/dir/kbase");
    expect(screen.getByText("Docs")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Docs" })).not.toBeInTheDocument();
  });

  it("restores everything listed, or only the ticked entries, and mounts the folder", async () => {
    axios.post.mockResolvedValue({ data: { path: "/Volumes/kopia" } });
    renderBrowse();
    await waitFor(() => expect(screen.getByText("Mount to browse")).toBeInTheDocument());
    expect(screen.getByTestId("restore")).toHaveTextContent("Restore all");
    expect(screen.getByTestId("restore")).toHaveAttribute("href", "/snapshots/dir/kroot/restore");

    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByTestId("restore")).toHaveTextContent("Restore 1 selected");

    fireEvent.click(screen.getByText("Mount to browse"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/mounts", { root: "kroot" }));
  });

  it("shows an existing mount and unmounts it", async () => {
    axios.get.mockImplementation((url) =>
      Promise.resolve({ data: url.startsWith("/api/v1/mounts/") ? { path: "/Volumes/kopia" } : { entries } }),
    );
    axios.delete.mockResolvedValue({ data: {} });
    renderBrowse();
    await waitFor(() => expect(screen.getByLabelText("Mounted path")).toHaveValue("/Volumes/kopia"));
    fireEvent.click(screen.getByText("Unmount"));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith("/api/v1/mounts/kroot"));
  });

  it("says when a folder is empty", async () => {
    axios.get.mockImplementation((url) => Promise.resolve({ data: url.startsWith("/api/v1/mounts/") ? {} : {} }));
    renderBrowse();
    await waitFor(() => expect(screen.getByText("This folder is empty.")).toBeInTheDocument());
  });
});

const renderRestore = () =>
  render(
    <MemoryRouter initialEntries={["/snapshots/dir/kroot/restore"]}>
      <Routes>
        <Route path="/snapshots/dir/:oid/restore" element={<SnapshotRestore />} />
        <Route path="/tasks/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe("SnapshotRestore", () => {
  beforeEach(() => {
    axios.post.mockReset().mockResolvedValue({ data: { id: "task9" } });
  });

  it("needs a destination", async () => {
    renderRestore();
    fireEvent.click(screen.getByTestId("submit-button"));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter where to restore to.");
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("restores into a folder with the chosen options and links to the task", async () => {
    renderRestore();
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "/tmp/out" } });
    fireEvent.click(screen.getByLabelText("Overwrite files"));
    fireEvent.click(screen.getByTestId("submit-button"));

    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    const [url, req] = axios.post.mock.calls[0];
    expect(url).toBe("/api/v1/restore");
    expect(req.root).toBe("kroot");
    expect(req.fsOutput).toMatchObject({ targetPath: "/tmp/out", overwriteFiles: true, skipOwners: false });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open the task" })).toHaveAttribute("href", "/tasks/task9"),
    );
  });

  it("restores each ticked entry into the chosen folder", async () => {
    const items = [
      { obj: "o1", name: "b.txt" },
      { obj: "kdocs", name: "Docs" },
    ];
    render(
      <MemoryRouter initialEntries={[{ pathname: "/snapshots/dir/kroot/restore", state: { items } }]}>
        <Routes>
          <Route path="/snapshots/dir/:oid/restore" element={<SnapshotRestore />} />
          <Route path="/tasks" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("2 items selected")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Destination folder"), { target: { value: "/tmp/out/" } });
    fireEvent.click(screen.getByTestId("submit-button"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    expect(axios.post.mock.calls.map(([, r]) => [r.root, r.fsOutput.targetPath])).toEqual([
      ["o1", "/tmp/out/b.txt"],
      ["kdocs", "/tmp/out/Docs"],
    ]);
    await waitFor(() => expect(screen.getByRole("link", { name: "Open Tasks" })).toHaveAttribute("href", "/tasks"));
  });

  it("shows the zip option only for a zip file", async () => {
    renderRestore();
    expect(screen.queryByLabelText("Disable ZIP compression")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "/tmp/out.zip" } });
    expect(screen.getByLabelText("Disable ZIP compression")).toBeChecked();
  });

  it("reports a refused restore", async () => {
    axios.post.mockRejectedValue({ message: "x", response: { data: { message: "destination exists" } } });
    renderRestore();
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "/tmp/out" } });
    fireEvent.click(screen.getByTestId("submit-button"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not started: destination exists"));
  });
});

describe("browse helpers", () => {
  it("picks the size of a file or a folder", () => {
    expect(entrySize({ size: 5 })).toBe(5);
    expect(entrySize({ summ: { size: 9 } })).toBe(9);
    expect(entrySize({})).toBe(0);
  });

  it("links folders to the page and files to a download", () => {
    expect(entryLink({ obj: "kabc", name: "d" })).toEqual({ page: true, to: "/snapshots/dir/kabc" });
    expect(entryLink({ obj: "oabc", name: "a b" })).toEqual({ page: false, href: "/api/v1/objects/oabc?fname=a%20b" });
  });

  it("builds the restore request for a folder, a zip and a tar", () => {
    const f = { ...RESTORE_DEFAULTS, destination: "/x", overwriteFiles: true };
    expect(restoreRequest("k", f).fsOutput.targetPath).toBe("/x");
    expect(restoreRequest("k", { ...f, destination: "/x.zip" })).toMatchObject({
      zipFile: "/x.zip",
      uncompressedZip: true,
    });
    expect(restoreRequest("k", { ...f, destination: "/x.tar" }).tarFile).toBe("/x.tar");
    expect(restoreRequest("k", { ...f, destination: "/x.zip" }).fsOutput).toBeUndefined();
    expect(restoreRequest("k", { ...f, restoreDirEntryAtDepth: "3" }).options.restoreDirEntryAtDepth).toBe(3);
  });
});
