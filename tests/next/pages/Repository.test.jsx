import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { RouterProvider, createMemoryRouter } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { NextContext } from "../../../src/next/context";
import { Repository } from "../../../src/next/pages/Repository";
import { clock, repoFacts } from "../../../src/next/repository";

vi.mock("axios");
vi.mock("../../../src/components/SetupRepository", () => ({ SetupRepository: () => <div>setup wizard</div> }));

const connected = (over = {}) => ({
  connected: true,
  description: "Repository in SFTP",
  username: "me",
  hostname: "mac",
  storage: "sftp",
  encryption: "AES256-GCM-HMAC-SHA256",
  hash: "BLAKE2B-256-128",
  splitter: "DYNAMIC-4M-BUZHASH",
  formatVersion: "3",
  eccOverheadPercent: 0,
  supportsContentCompression: true,
  configFile: "/Users/me/repository.config",
  ...over,
});

const shell = { repoConnected: true, repoDescription: "", runningTasks: 0, refreshRepo: vi.fn() };

const renderPage = () => {
  const router = createMemoryRouter([{ path: "*", element: <Repository /> }]);
  return render(
    <NextContext.Provider value={shell}>
      <UIPreferencesContext.Provider value={{ pageSize: 25, bytesStringBase2: false }}>
        <RouterProvider router={router} />
      </UIPreferencesContext.Provider>
    </NextContext.Provider>,
  );
};

const serve = (
  status,
  usage = { blobCount: 0, totalBytes: 0 },
  health = { state: "ok", checks: [] },
  failures = null,
) =>
  axios.get.mockImplementation((url) =>
    Promise.resolve({
      data:
        url === "/api/v1/repo/status"
          ? status
          : url.startsWith("/api/v1/repo/storage-usage")
            ? usage
            : url === "/api/v1/verify/status"
              ? health
              : failures && url.startsWith("/api/v1/snapshots/verifications/")
                ? failures
                : { logs: [] },
    }),
  );

describe("Repository page", () => {
  beforeEach(() => {
    shell.refreshRepo.mockReset();
    axios.get.mockReset();
    axios.post.mockReset().mockResolvedValue({ data: {} });
  });

  it("shows how the repository is set up", async () => {
    serve(connected());
    renderPage();
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());

    expect(screen.getByLabelText("Description")).toHaveValue("Repository in SFTP");
    expect(screen.getByText("me@mac")).toBeInTheDocument();
    expect(screen.getByText("AES256-GCM-HMAC-SHA256")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/repository.config")).toBeInTheDocument();
    expect(screen.getByText("Not calculated yet.")).toBeInTheDocument();
  });

  it("saves a new description, but not an empty or unchanged one", async () => {
    serve(connected());
    axios.post.mockResolvedValue({ data: { description: "New" } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Description")).toBeInTheDocument());
    expect(screen.getByTestId("update-description")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "" } });
    expect(screen.getByTestId("update-description")).toBeDisabled();
    expect(screen.getByText("A description is required.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New" } });
    fireEvent.click(screen.getByTestId("update-description"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/repo/description", { description: "New" }));
    await waitFor(() => expect(shell.refreshRepo).toHaveBeenCalled());
  });

  it("shows the last storage size, and calculates a new one on request", async () => {
    serve(connected(), { blobCount: 1234, totalBytes: 148e9, computedAt: "2026-10-23T10:00:00Z", running: false });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("148 GB in 1.2K blobs"));

    fireEvent.click(screen.getByTestId("refresh-storage-usage"));
    await waitFor(() =>
      expect(axios.get).toHaveBeenCalledWith("/api/v1/repo/storage-usage", { params: { refresh: "true" } }),
    );
  });

  it("shows that a calculation is running", async () => {
    serve(connected(), {
      blobCount: 0,
      totalBytes: 0,
      running: true,
      startedAt: new Date(Date.now() - 65000).toISOString(),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("Calculating"));
    expect(screen.getByTestId("refresh-storage-usage")).toBeDisabled();
  });

  it("disconnects after confirming", async () => {
    serve(connected());
    renderPage();
    await waitFor(() => expect(screen.getByTestId("disconnect")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("disconnect"));
    expect(axios.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/repo/disconnect", {}));
  });

  it("warns about a read-only repository and shows a server repository's URL", async () => {
    serve(connected({ readonly: true, apiServerURL: "https://kopia.example:51515" }));
    renderPage();
    await waitFor(() => expect(screen.getByText("The repository is read-only.")).toBeInTheDocument());
    expect(screen.getByText("https://kopia.example:51515")).toBeInTheDocument();
    expect(screen.queryByTestId("storage-usage")).not.toBeInTheDocument();
  });

  it("shows the connection while it is being made, and can cancel it", async () => {
    serve({ connected: false, initTaskID: "init1" });
    renderPage();
    await waitFor(() => expect(screen.getByText("Connecting to the repository")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Cancel connection"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/tasks/init1/cancel", {}));
  });

  it("offers the setup when there is no repository", async () => {
    serve({ connected: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("setup wizard")).toBeInTheDocument());
  });
});

describe("repository helpers", () => {
  it("writes a clock", () => {
    expect(clock(125)).toBe("2:05");
    expect(clock(5)).toBe("0:05");
  });

  it("lists the facts of a repository, or just the URL of a server", () => {
    expect(repoFacts({ apiServerURL: "https://x" })).toEqual([["Server URL", "https://x"]]);
    const f = Object.fromEntries(repoFacts(connected({ eccOverheadPercent: 2, ecc: "RS" })));
    expect(f["Error correction"]).toBe("RS 2%");
    expect(f["Internal compression"]).toBe("yes");
    expect(Object.fromEntries(repoFacts(connected()))["Error correction"]).toBe("Disabled");
  });

  it("shows the health checks and runs the full check", async () => {
    serve(connected(), undefined, {
      state: "failing",
      since: "2026-10-23T10:00:00Z",
      lastDeepRun: "2026-10-23T03:00:00Z",
      lastDeepTaskId: "d1",
      checks: [
        { name: "Snapshots are recent", ok: false, detail: "3 h old", checkedAt: "2026-10-23T11:00:00Z" },
        { name: "Snapshots can be read", ok: true, detail: "40 snapshots" },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Problem")).toBeInTheDocument());
    expect(screen.getByText("3 h old")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("log")).toHaveAttribute("href", "/tasks/d1");

    fireEvent.click(screen.getByText("Run full check now"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/verify/run", {}));
    await waitFor(() => expect(screen.getByText("Check started.")).toBeInTheDocument());
  });

  it("names the files a failed data check could not read, and loads all of them on request", async () => {
    const check = {
      name: "Sample of stored data verifies",
      ok: false,
      detail: "7 of 900 files failed to read back; first: /Applications/A.app/x: bad",
      failureCount: 7,
      verificationId: 42,
      failures: [
        { path: "/Applications/A.app/x", error: "bad" },
        { path: "/Users/me/.npm/y", error: "invalid length" },
      ],
    };
    serve(
      connected(),
      undefined,
      { state: "failing", since: "2026-10-24T10:00:00Z", checks: [check] },
      { failures: Array.from({ length: 7 }, (_, i) => ({ path: "/p/f" + i, error: "bad" })) },
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId("check-failures")).toBeInTheDocument());
    const list = screen.getByTestId("check-failures");
    expect(list).toHaveTextContent("7 files failed");
    expect(list).toHaveTextContent("/Users/me/.npm/y");
    expect(screen.getByText("7 of 900 files failed to read back")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show all 7"));
    await waitFor(() => expect(screen.getByTestId("check-failures")).toHaveTextContent("/p/f6"));
  });
});
