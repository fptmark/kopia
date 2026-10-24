import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { Policies } from "../../../src/next/pages/Policies";
import { Policy } from "../../../src/next/pages/Policy";
import { SnapshotCreate } from "../../../src/next/pages/SnapshotCreate";

vi.mock("axios");

const prefs = { pageSize: 25, bytesStringBase2: false };

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

describe("Policies page", () => {
  const policies = [
    {
      id: "g",
      target: { userName: "", host: "", path: "" },
      policy: { retention: { keepLatest: 10 }, files: { ignore: ["a"] } },
    },
    { id: "h", target: { userName: "me", host: "mac", path: "/Users/me" }, policy: { files: { ignore: ["/x"] } } },
    { id: "o", target: { userName: "you", host: "other", path: "/data" }, policy: { retention: { keepDaily: 3 } } },
    { id: "u", target: { userName: "me", host: "mac", path: "" }, policy: {} },
  ];

  beforeEach(() => {
    axios.get.mockReset().mockImplementation((url) =>
      Promise.resolve({
        data: url === "/api/v1/policies" ? { policies } : { localUsername: "me", localHost: "mac", sources: [] },
      }),
    );
  });

  it("shows the policies that apply here, with what each sets", async () => {
    render(
      <MemoryRouter initialEntries={["/policies"]}>
        <UIPreferencesContext.Provider value={prefs}>
          <Routes>
            <Route path="/policies" element={<Policies />} />
          </Routes>
        </UIPreferencesContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("/Users/me")).toBeInTheDocument());

    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.queryByText("/data")).not.toBeInTheDocument();
    const row = screen.getByText("/Users/me").closest("tr");
    expect(within(row).getByText("files")).toBeInTheDocument();
  });

  it("opens the editor for a typed folder, and refuses a relative path", async () => {
    render(
      <MemoryRouter initialEntries={["/policies"]}>
        <UIPreferencesContext.Provider value={prefs}>
          <Routes>
            <Route path="/policies" element={<Policies />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </UIPreferencesContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText("Folder")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "relative/dir" } });
    fireEvent.click(screen.getByText("Set policy"));
    expect(screen.getByRole("alert")).toHaveTextContent("relative paths");

    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/Users/me/Projects" } });
    fireEvent.click(screen.getByText("Set policy"));
    expect(screen.getByTestId("where")).toHaveTextContent(
      "/policies/edit?userName=me&host=mac&path=%2FUsers%2Fme%2FProjects",
    );
  });

  it("lists other people's policies under All policies", async () => {
    render(
      <MemoryRouter initialEntries={["/policies"]}>
        <UIPreferencesContext.Provider value={prefs}>
          <Routes>
            <Route path="/policies" element={<Policies />} />
          </Routes>
        </UIPreferencesContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText("Show")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    expect(screen.getByText("/data")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter policies"), { target: { value: "data" } });
    expect(screen.queryByText("/Users/me")).not.toBeInTheDocument();
  });
});

describe("Policy page", () => {
  const resolved = (extra = {}) => ({
    effective: {
      retention: { keepLatest: 10, keepDaily: 7 },
      scheduling: { intervalSeconds: 3600 },
      files: { ignore: ["node_modules/"] },
    },
    definition: {
      retention: {
        keepLatest: { userName: "", host: "", path: "" },
        keepDaily: { userName: "me", host: "mac", path: "/Users/me" },
      },
      scheduling: { intervalSeconds: { userName: "", host: "", path: "" } },
    },
    upcomingSnapshotTimes: ["2026-10-24T01:00:00Z"],
    ...extra,
  });

  const serve = ({ policy, notFound = false } = {}) => {
    axios.get.mockReset().mockImplementation((url) => {
      if (url.startsWith("/api/v1/repo/algorithms")) {
        return Promise.resolve({ data: { compression: [{ id: "zstd" }, { id: "gzip", deprecated: true }] } });
      }
      if (notFound) {
        return Promise.reject({ response: { status: 404, data: { code: "NOT_FOUND" } } });
      }
      return Promise.resolve({ data: policy ?? { retention: { keepDaily: 7 } } });
    });
    axios.post.mockReset().mockResolvedValue({ data: resolved() });
    axios.put.mockReset().mockResolvedValue({ data: {} });
    axios.delete.mockReset().mockResolvedValue({ data: {} });
  };

  const renderPage = (search = "?userName=me&host=mac&path=%2FUsers%2Fme") =>
    render(
      <MemoryRouter initialEntries={["/policies", "/policies/edit" + search]} initialIndex={1}>
        <UIPreferencesContext.Provider value={prefs}>
          <Routes>
            <Route path="/policies/edit" element={<Policy />} />
            <Route path="/policies" element={<Where />} />
          </Routes>
        </UIPreferencesContext.Provider>
      </MemoryRouter>,
    );

  it("shows what this policy says and what is in effect, with where it comes from", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("effective-retention.keepLatest")).toHaveTextContent("10"));

    expect(screen.getByTestId("effective-retention.keepLatest")).toHaveTextContent("from the global policy");
    expect(screen.getByTestId("effective-retention.keepDaily")).toHaveTextContent("from this policy");
    expect(screen.getByLabelText("Daily")).toHaveValue(7);
    expect(screen.getByLabelText("Latest")).toHaveValue(null);
    expect(screen.getByText("Directory: me@mac:/Users/me")).toBeInTheDocument();
  });

  it("keeps Save muted until something changed, then saves what was cleaned and goes back", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Daily")).toBeInTheDocument());
    expect(screen.getByTestId("button-save")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Daily"), { target: { value: "14" } });
    expect(screen.getByTestId("button-save")).toBeEnabled();
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() =>
      expect(axios.put).toHaveBeenCalledWith(expect.stringContaining("/api/v1/policy?"), {
        retention: { keepDaily: 14 },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("where")).toBeInTheDocument());
  });

  it("asks the server what a change does, once the typing stops", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Daily")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Daily"), { target: { value: "30" } });
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/policy/resolve?"),
        expect.objectContaining({ updates: { retention: { keepDaily: 30 } } }),
      ),
    );
  });

  it("clears a setting back to inherit", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Daily")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Daily"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.any(String), {}));
  });

  it("offers a new policy when none exists, and saves it", async () => {
    serve({ notFound: true });
    renderPage();
    await waitFor(() => expect(screen.getByText(/does not exist yet/)).toBeInTheDocument());
    expect(screen.queryByText("Delete policy")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Latest"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.any(String), { retention: { keepLatest: 5 } }));
  });

  it("switches sections, with the schedule's next times", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-scheduling")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-scheduling"));
    await waitFor(() => expect(screen.getByTestId("upcoming-snapshot-times")).toBeInTheDocument());
    expect(screen.getByTestId("effective-scheduling.intervalSeconds")).toHaveTextContent("1 hr");

    fireEvent.click(screen.getByTestId("tab-files"));
    expect(screen.getByTestId("effective-files.ignore")).toHaveTextContent("node_modules/");
    expect(screen.getByText("Open exclusions")).toHaveAttribute("href", "/exclusions");
  });

  it("refuses to save a time of day that is not a time", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-scheduling")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-scheduling"));
    fireEvent.change(screen.getByLabelText("At times of day"), { target: { value: "noon" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid time of day: 'noon'"));
    expect(axios.put).not.toHaveBeenCalled();
  });

  it("deletes a policy after confirming, but never the global one", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByText("Delete policy")).toBeEnabled());
    fireEvent.click(screen.getByText("Delete policy"));
    expect(axios.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.delete).toHaveBeenCalled());
  });

  it("does not allow deleting the global policy", async () => {
    serve();
    renderPage("?userName=&host=&path=");
    await waitFor(() => expect(screen.getByText("Delete policy")).toBeDisabled());
    expect(screen.getByText("Global Policy")).toBeInTheDocument();
  });

  it("shows why a policy could not be saved", async () => {
    serve();
    axios.put.mockRejectedValue({ message: "x", response: { data: { message: "not allowed" } } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Daily")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Daily"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not saved: not allowed"));
  });
});

describe("SnapshotCreate page", () => {
  beforeEach(() => {
    axios.get.mockReset().mockImplementation((url) => {
      if (url.startsWith("/api/v1/repo/algorithms")) {
        return Promise.resolve({ data: { compression: [] } });
      }
      if (url.startsWith("/api/v1/policy?")) {
        return Promise.reject({ response: { status: 404, data: { code: "NOT_FOUND" } } });
      }
      if (url.startsWith("/api/v1/tasks/")) {
        return Promise.resolve({
          data: {
            id: "e1",
            status: "SUCCESS",
            endTime: "2026-10-23T10:00:00Z",
            counters: { Bytes: { value: 5e9 }, Files: { value: 1200 }, "Excluded Files": { value: 30 } },
          },
        });
      }
      return Promise.reject(new Error(url));
    });
    axios.post.mockReset().mockImplementation((url) => {
      if (url === "/api/v1/paths/resolve") {
        return Promise.resolve({ data: { source: { host: "mac", userName: "me", path: "/Users/me/Docs" } } });
      }
      if (url === "/api/v1/estimate") {
        return Promise.resolve({ data: { id: "e1" } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={["/snapshots", "/snapshots/new"]} initialIndex={1}>
        <UIPreferencesContext.Provider value={prefs}>
          <Routes>
            <Route path="/snapshots/new" element={<SnapshotCreate />} />
            <Route path="/snapshots" element={<Where />} />
          </Routes>
        </UIPreferencesContext.Provider>
      </MemoryRouter>,
    );

  it("keeps Estimate and Snapshot now muted until the path resolves", async () => {
    renderPage();
    expect(screen.getByTestId("snapshot-now")).toBeDisabled();
    expect(screen.getByTestId("estimate-now")).toBeDisabled();

    fireEvent.change(screen.getByTestId("control-path"), { target: { value: "~/Docs" } });
    await waitFor(() => expect(screen.getByTestId("snapshot-now")).toBeEnabled());
    expect(screen.getByText("Resolved to /Users/me/Docs")).toBeInTheDocument();
  });

  it("estimates with the policy being edited and shows the counts", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("control-path"), { target: { value: "~/Docs" } });
    await waitFor(() => expect(screen.getByTestId("estimate-now")).toBeEnabled());
    await waitFor(() => expect(screen.getByTestId("policy-fields")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Daily"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("estimate-now"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("/api/v1/estimate", {
        root: "/Users/me/Docs",
        maxExamplesPerBucket: 10,
        policyOverride: { retention: { keepDaily: 5 } },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("estimate-result")).toHaveTextContent("1,200"));
    expect(screen.getByTestId("estimate-result")).toHaveTextContent("5 GB");
  });

  it("starts the snapshot with the policy and goes back", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("control-path"), { target: { value: "~/Docs" } });
    await waitFor(() => expect(screen.getByTestId("snapshot-now")).toBeEnabled());
    await waitFor(() => expect(screen.getByTestId("policy-fields")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("snapshot-now"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("/api/v1/sources", {
        path: "/Users/me/Docs",
        createSnapshot: true,
        policy: {},
      }),
    );
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/snapshots"));
  });
});
