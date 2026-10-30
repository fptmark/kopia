import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router";
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

// useBlocker (Page's unsaved-changes guard) needs a data router, not plain MemoryRouter.
function renderRoutes(routes, opts) {
  const router = createMemoryRouter(routes, opts);
  return render(
    <UIPreferencesContext.Provider value={prefs}>
      <RouterProvider router={router} />
    </UIPreferencesContext.Provider>,
  );
}

describe("Policies page", () => {
  const policies = [
    {
      id: "g",
      target: { userName: "", host: "", path: "" },
      // logging is present but every leaf under it is empty -- a struct the server always sends, not something
      // the user set -- so it must not count as a defined section (unlike files, which has a real value).
      policy: { retention: { keepLatest: 10 }, files: { ignore: ["a"] }, logging: { directories: {}, entries: {} } },
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
    renderRoutes([{ path: "/policies", element: <Policies /> }], { initialEntries: ["/policies"] });
    await waitFor(() => expect(screen.getByText("/Users/me")).toBeInTheDocument());

    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.queryByText("/data")).not.toBeInTheDocument();
    const row = screen.getByText("/Users/me").closest("tr");
    expect(within(row).getByText("Files")).toBeInTheDocument();

    // logging has keys in its JSON but nothing set underneath, so it's not shown as a defined section
    const globalRow = screen.getByText("Global").closest("tr");
    expect(within(globalRow).getByText("Files")).toBeInTheDocument();
    expect(within(globalRow).queryByText("Logging")).not.toBeInTheDocument();
  });

  it("opens a blank editor to start a new policy, no source pre-selected", async () => {
    renderRoutes(
      [
        { path: "/policies", element: <Policies /> },
        { path: "*", element: <Where /> },
      ],
      { initialEntries: ["/policies"] },
    );
    await waitFor(() => expect(screen.getByTestId("add-policy")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("add-policy"));
    expect(screen.getByTestId("where")).toHaveTextContent("/policies/edit");
  });

  it("lists other people's policies under All policies", async () => {
    renderRoutes([{ path: "/policies", element: <Policies /> }], { initialEntries: ["/policies"] });
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
      if (url.startsWith("/api/v1/sources")) {
        // renderPage's default target is this source itself, not a subfolder of one
        return Promise.resolve({
          data: {
            localUsername: "me",
            localHost: "mac",
            sources: [{ source: { userName: "me", host: "mac", path: "/Users/me" } }],
          },
        });
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
    renderRoutes(
      [
        { path: "/policies/edit", element: <Policy /> },
        { path: "/policies", element: <Where /> },
      ],
      { initialEntries: ["/policies", "/policies/edit" + search], initialIndex: 1 },
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

  it("bolds a tab's label only when this policy really sets something in it", async () => {
    // logging has keys in its JSON but nothing set underneath -- same shape the server sends for an untouched
    // section -- so its tab must stay plain while retention's (a real value) is bold.
    serve({ policy: { retention: { keepDaily: 7 }, logging: { directories: {}, entries: {} } } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-retention")).toBeInTheDocument());
    expect(screen.getByTestId("tab-retention")).toHaveClass("fw-semibold");
    expect(screen.getByTestId("tab-logging")).not.toHaveClass("fw-semibold");
  });

  it("shows the source itself as the current breadcrumb, with Policies as the only link above it", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("policy-fields")).toBeInTheDocument());
    const crumbs = screen.getByLabelText("Where you are");
    expect(within(crumbs).getByRole("link", { name: "Policies" })).toHaveAttribute("href", "/policies");
    expect(within(crumbs).getByText("/Users/me")).toBeInTheDocument();
  });

  it("breaks a subfolder's breadcrumb into the source and each segment, every ancestor a link", async () => {
    serve();
    renderPage("?userName=me&host=mac&path=%2FUsers%2Fme%2FDownloads%2FOld");
    await waitFor(() => expect(screen.getByTestId("policy-fields")).toBeInTheDocument());
    const crumbs = screen.getByLabelText("Where you are");
    expect(within(crumbs).getByRole("link", { name: "/Users/me" })).toHaveAttribute(
      "href",
      "/policies/edit?userName=me&host=mac&path=%2FUsers%2Fme",
    );
    expect(within(crumbs).getByRole("link", { name: "Downloads" })).toHaveAttribute(
      "href",
      "/policies/edit?userName=me&host=mac&path=%2FUsers%2Fme%2FDownloads",
    );
    expect(within(crumbs).getByText("Old")).toBeInTheDocument();
    // Retention is source-only, so it drops out of the tab bar for a subfolder
    expect(screen.queryByTestId("tab-retention")).not.toBeInTheDocument();
  });

  it("shows no relationship banner for a source's own root, with no way to switch source", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("policy-fields")).toBeInTheDocument());
    expect(screen.queryByText(/one of your sources/)).not.toBeInTheDocument();
    expect(screen.queryByText("Policy for")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
  });

  it("shows an info banner for a subfolder of a source", async () => {
    serve();
    renderPage("?userName=me&host=mac&path=%2FUsers%2Fme%2FDownloads");
    await waitFor(() => expect(screen.getByTestId("policy-fields")).toBeInTheDocument());
    expect(screen.getByText(/subfolder of your source/)).toBeInTheDocument();
  });

  it("shows every tab with a source picker when nothing is picked yet, Save stuck off", async () => {
    serve();
    renderPage("");
    await waitFor(() => expect(screen.getByTestId("policy-fields")).toBeInTheDocument());

    expect(screen.getByRole("heading", { name: "New policy" })).toBeInTheDocument();
    const crumbs = screen.getByLabelText("Where you are");
    expect(within(crumbs).getByRole("link", { name: "Policies" })).toHaveAttribute("href", "/policies");
    expect(within(crumbs).getByText("New policy")).toBeInTheDocument();
    expect(screen.getByLabelText("Source")).toBeInTheDocument();
    expect(screen.getByTestId("tab-retention")).toBeInTheDocument();
    expect(screen.getByTestId("button-save")).toBeDisabled();

    // editing a field before a source is picked is still possible, but Save stays off regardless
    fireEvent.change(screen.getByLabelText("Latest"), { target: { value: "5" } });
    expect(screen.getByTestId("button-save")).toBeDisabled();
  });

  it("binds to a real target once a source is picked from the blank editor", async () => {
    serve();
    renderPage("");
    await waitFor(() => expect(screen.getByLabelText("Source")).toBeInTheDocument());
    fireEvent.focus(screen.getByLabelText("Source"));
    fireEvent.click(screen.getByText("/Users/me"));
    await waitFor(() => expect(screen.getByLabelText("Daily")).toBeInTheDocument());
    expect(screen.getByText("Directory: me@mac:/Users/me")).toBeInTheDocument();
    // the source combo is gone now that we're bound to a real target
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
  });

  it("flags switching to edit mode when the picked source already has a policy", async () => {
    serve();
    renderPage("");
    await waitFor(() => expect(screen.getByLabelText("Source")).toBeInTheDocument());
    fireEvent.focus(screen.getByLabelText("Source"));
    fireEvent.click(screen.getByText("/Users/me"));
    await waitFor(() =>
      expect(screen.getByText("Policy exists for this source — switching to edit mode.")).toBeInTheDocument(),
    );
  });

  it("says nothing about switching modes when the picked source has no policy yet", async () => {
    serve({ notFound: true });
    renderPage("");
    await waitFor(() => expect(screen.getByLabelText("Source")).toBeInTheDocument());
    fireEvent.focus(screen.getByLabelText("Source"));
    fireEvent.click(screen.getByText("/Users/me"));
    await waitFor(() => expect(screen.getByLabelText("Latest")).toBeInTheDocument());
    expect(screen.queryByText(/switching to edit mode/)).not.toBeInTheDocument();
    expect(screen.queryByText(/does not exist yet/)).not.toBeInTheDocument();
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

  it("warns before leaving an edited policy unsaved, and leaves when confirmed", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Daily")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Daily"), { target: { value: "3" } });

    fireEvent.click(screen.getByRole("link", { name: "Policies" }));
    expect(screen.getByText("Leave without saving?")).toBeInTheDocument();
    expect(screen.queryByTestId("where")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/policies"));
    expect(axios.put).not.toHaveBeenCalled();
  });

  it("offers a new policy when none exists, and saves it", async () => {
    serve({ notFound: true });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Latest")).toBeInTheDocument());
    expect(screen.queryByText(/does not exist yet/)).not.toBeInTheDocument();
    expect(screen.queryByText("Delete policy")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Latest"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.any(String), { retention: { keepLatest: 5 } }));
  });

  it("switches sections, with the schedule's next times", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-schedule"));
    fireEvent.click(screen.getByTestId("tab-scheduling"));
    await waitFor(() => expect(screen.getByTestId("upcoming-snapshot-times")).toBeInTheDocument());
    expect(screen.getByTestId("effective-scheduling.intervalSeconds")).toHaveTextContent("1 hr");

    fireEvent.click(screen.getByTestId("tab-files"));
    expect(screen.getByTestId("effective-files.ignore")).toHaveTextContent("node_modules/");
    expect(screen.getByText("Open exclusions")).toHaveAttribute("href", "/exclusions");
  });

  it("has its own verify schedule tab, independent of the snapshot schedule", async () => {
    serve();
    axios.post.mockResolvedValue({
      data: resolved({
        upcomingVerifyTimes: ["2026-10-25T02:00:00Z"],
        effective: {
          retention: { keepLatest: 10, keepDaily: 7 },
          scheduling: { intervalSeconds: 3600 },
          verifyScheduling: { scheduling: { intervalSeconds: 86400 }, mode: "sample", percent: 25 },
          files: { ignore: ["node_modules/"] },
        },
      }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-schedule"));
    fireEvent.click(screen.getByTestId("tab-verifyScheduling"));

    await waitFor(() => expect(screen.getByTestId("upcoming-verify-times")).toBeInTheDocument());
    expect(screen.getByTestId("effective-verifyScheduling.scheduling.intervalSeconds")).toHaveTextContent("1 day");
    expect(screen.getByTestId("effective-verifyScheduling.percent")).toHaveTextContent("25");

    fireEvent.change(screen.getByLabelText("Verify"), { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() =>
      expect(axios.put).toHaveBeenCalledWith(expect.any(String), {
        retention: { keepDaily: 7 },
        verifyScheduling: { percent: 40 },
      }),
    );
  });

  it("saves 100 percent as mode: full, with no separate percent field", async () => {
    serve();
    axios.post.mockResolvedValue({
      data: resolved({
        upcomingVerifyTimes: ["2026-10-25T02:00:00Z"],
        effective: {
          retention: { keepLatest: 10, keepDaily: 7 },
          scheduling: { intervalSeconds: 3600 },
          verifyScheduling: { scheduling: { intervalSeconds: 86400 }, mode: "sample", percent: 25 },
          files: { ignore: ["node_modules/"] },
        },
      }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-schedule"));
    fireEvent.click(screen.getByTestId("tab-verifyScheduling"));
    await waitFor(() => expect(screen.getByLabelText("Verify")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Verify"), { target: { value: "100" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() =>
      expect(axios.put).toHaveBeenCalledWith(expect.any(String), {
        retention: { keepDaily: 7 },
        verifyScheduling: { mode: "full" },
      }),
    );
  });

  it("refuses to save a time of day that is not a time", async () => {
    serve();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-schedule"));
    fireEvent.change(screen.getByLabelText("Times of day"), { target: { value: "noon" } });
    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid time of day: 'noon'"));
    expect(axios.put).not.toHaveBeenCalled();
  });

  it("picks an interval or times of day, never both", async () => {
    serve({ policy: { retention: { keepDaily: 7 }, scheduling: { intervalSeconds: 3600 } } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tab-schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-schedule"));

    // starts in interval mode, since that is what this policy already has
    await waitFor(() => expect(screen.getByLabelText("Interval")).toBeInTheDocument());
    expect(screen.queryByLabelText("Times of day")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("At specific times of day"));
    expect(screen.queryByLabelText("Interval")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Times of day"), { target: { value: "9:30" } });

    fireEvent.click(screen.getByTestId("button-save"));
    await waitFor(() =>
      expect(axios.put).toHaveBeenCalledWith(expect.any(String), {
        retention: { keepDaily: 7 },
        scheduling: { timeOfDay: [{ hour: 9, min: 30 }] },
      }),
    );
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

  it("says nothing extra for a per-user policy with nothing saved yet -- new just means new", async () => {
    serve({ notFound: true });
    renderPage("?userName=me&host=mac&path=");
    await waitFor(() => expect(screen.getByText("User: me@mac")).toBeInTheDocument());
    expect(screen.queryByText(/does not exist yet/)).not.toBeInTheDocument();
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
    renderRoutes(
      [
        { path: "/snapshots/new", element: <SnapshotCreate /> },
        { path: "/snapshots", element: <Where /> },
      ],
      { initialEntries: ["/snapshots", "/snapshots/new"], initialIndex: 1 },
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
