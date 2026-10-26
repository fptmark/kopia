import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

vi.mock("axios");

const pages = [
  "Snapshots",
  "SnapshotHistory",
  "SnapshotDiff",
  "SnapshotDirectory",
  "SnapshotRestore",
  "SnapshotCreate",
  "Files",
  "Policies",
  "Policy",
  "Tasks",
  "Task",
  "Exclusions",
  "Preferences",
  "Repository",
  "About",
  "Spec",
];
for (const p of pages) {
  vi.doMock(`../../src/next/pages/${p}`, () => ({ [p]: () => <div data-testid={"page-" + p}>{p} page</div> }));
}

async function renderAt(path, { connected = true, theme = "dark", running = 0 } = {}) {
  window.history.pushState({}, "", path);
  axios.get.mockReset().mockImplementation((url) => {
    if (url === "/api/v1/repo/status") {
      return Promise.resolve({ data: { connected, description: "Repository in SFTP" } });
    }
    if (url === "/api/v1/tasks-summary") {
      return Promise.resolve({ data: { RUNNING: running } });
    }
    if (url === "/api/v1/ui-preferences") {
      return Promise.resolve({ data: { theme, fontSize: "fs-6", pageSize: 25 } });
    }
    return Promise.resolve({ data: { state: "ok", checks: [] } });
  });
  vi.resetModules();
  const { default: NextApp } = await import("../../src/next/NextApp");
  return render(<NextApp />);
}

describe("NextApp", () => {
  beforeEach(() => {
    axios.put.mockReset().mockResolvedValue({ data: {} });
  });

  it("shows the page of the address", async () => {
    await renderAt("/exclusions");
    await waitFor(() => expect(screen.getByTestId("page-Exclusions")).toBeInTheDocument());
  });

  it("sends the front page to the snapshots", async () => {
    await renderAt("/");
    await waitFor(() => expect(screen.getByTestId("page-Snapshots")).toBeInTheDocument());
  });

  it("routes every page", async () => {
    const cases = [
      ["/snapshots/single-source?path=%2Fa", "SnapshotHistory"],
      ["/snapshots/diff?from=a&to=b", "SnapshotDiff"],
      ["/snapshots/dir/k1", "SnapshotDirectory"],
      ["/snapshots/dir/k1/restore", "SnapshotRestore"],
      ["/snapshots/new", "SnapshotCreate"],
      ["/files", "Files"],
      ["/policies", "Policies"],
      ["/policies/edit?path=%2Fa", "Policy"],
      ["/tasks", "Tasks"],
      ["/tasks/t1", "Task"],
      ["/preferences", "Preferences"],
      ["/repo", "Repository"],
      ["/about", "About"],
      ["/spec", "Spec"],
    ];
    for (const [path, page] of cases) {
      const { unmount } = await renderAt(path);
      await waitFor(() => expect(screen.getByTestId("page-" + page)).toBeInTheDocument());
      unmount();
    }
  });

  it("has a tab for each page, with the repository's name", async () => {
    await renderAt("/snapshots");
    await waitFor(() => expect(screen.getByText("Repository in SFTP")).toBeInTheDocument());
    for (const t of ["Volumes", "Files", "Exclusions", "Policies", "Tasks", "Repository", "Preferences", "About"]) {
      expect(screen.getByRole("link", { name: new RegExp("^" + t) })).toBeInTheDocument();
    }
    expect(screen.getByTestId("tab-snapshots")).toHaveClass("active");
  });

  it("mutes the tabs that need a repository while there is none", async () => {
    await renderAt("/repo", { connected: false });
    await waitFor(() => expect(screen.getByTestId("page-Repository")).toBeInTheDocument());
    expect(screen.getByTestId("tab-snapshots")).toHaveClass("disabled");
    expect(screen.getByTestId("tab-tasks")).toHaveClass("disabled");
    expect(screen.getByTestId("tab-repo")).not.toHaveClass("disabled");
    expect(screen.getByTestId("tab-preferences")).not.toHaveClass("disabled");
  });

  it("shows how many tasks are running", async () => {
    await renderAt("/snapshots", { running: 2 });
    await waitFor(() => expect(screen.getByTestId("tab-tasks")).toHaveTextContent("Tasks (2)"));
  });

  it("follows the saved theme, with light for the old UI's other themes", async () => {
    const { container } = await renderAt("/snapshots", { theme: "dark" });
    await waitFor(() => expect(container.querySelector(".nx")).toHaveAttribute("data-bs-theme", "dark"));
  });

  it("uses light for a theme the old UI had", async () => {
    const { container } = await renderAt("/snapshots", { theme: "ocean" });
    await waitFor(() => expect(container.querySelector(".nx")).toHaveAttribute("data-bs-theme", "light"));
  });
});
