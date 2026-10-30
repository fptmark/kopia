import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { RouterProvider, createMemoryRouter } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { Exclusions } from "../../../src/next/pages/Exclusions";

vi.mock("axios");

const rule = (id, source, pattern, extra = {}) => ({
  id,
  source,
  pattern,
  addedBy: "manual",
  addedAt: "2026-10-22T10:00:00Z",
  ...extra,
});

const base = () => ({
  imported: true,
  rules: [
    rule("g1", "", "node_modules/"),
    rule("g2", "", "Library/Caches/", { addedBy: "import", addedAt: undefined }),
    rule("s1", "/Users/me", "Projects/**/build/"),
  ],
  removed: [{ ...rule("r1", "", ".old/"), removedAt: "2026-10-23T09:00:00Z" }],
  sources: [
    { path: "/Applications", host: "h", userName: "u", ownRules: 0, netRules: 2, inSync: true },
    { path: "/Users/me", host: "h", userName: "u", ownRules: 1, netRules: 3, inSync: true },
  ],
  drift: [],
});

function serve(data, handlers = {}) {
  axios.get.mockImplementation((url) => {
    if (handlers[url]) {
      return handlers[url]();
    }
    return Promise.resolve({ data });
  });
}

const renderPage = () => {
  const router = createMemoryRouter([{ path: "*", element: <Exclusions /> }]);
  return render(
    <UIPreferencesContext.Provider value={{ pageSize: 25, bytesStringBase2: false }}>
      <RouterProvider router={router} />
    </UIPreferencesContext.Provider>,
  );
};

describe("Exclusions page", () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    axios.delete.mockReset();
  });

  it("lists the global rules with how each matches and when it was added", async () => {
    serve(base());
    renderPage();
    await waitFor(() => expect(screen.getByText("node_modules/")).toBeInTheDocument());

    expect(screen.getByText("Library/Caches/")).toBeInTheDocument();
    expect(screen.queryByText("Projects/**/build/")).not.toBeInTheDocument();
    expect(screen.getByText("before tracking")).toBeInTheDocument();
    expect(screen.getByText("Imported")).toBeInTheDocument();
    expect(screen.getAllByText("Any depth").length).toBeGreaterThan(0);
    expect(screen.getByTestId("tab-global")).toHaveTextContent("2");
  });

  it("shows the rules of one source on the Source tab, and lets the source be chosen", async () => {
    serve(base());
    renderPage();
    await waitFor(() => expect(screen.getByText("node_modules/")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("tab-source"));
    expect(screen.queryByText("This source has no rules of its own.")).not.toBeInTheDocument();
    expect(screen.getByText("Projects/**/build/")).toBeInTheDocument();
    expect(screen.queryByText("node_modules/")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "/Applications" } });
    expect(screen.getByText("This source has no rules of its own.")).toBeInTheDocument();
  });

  it("adds a global rule and says so", async () => {
    serve(base());
    axios.post.mockResolvedValue({ data: { added: [{ id: "n" }], existing: [], changes: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Pattern")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: " *.tmp " } });
    expect(screen.getByTestId("pattern-hint")).toHaveTextContent("Any depth");
    fireEvent.click(screen.getByText("Add rule"));

    await waitFor(() => expect(screen.getByText(/Added \*\.tmp/)).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith("/api/v1/exclusions", {
      rules: [{ source: "", pattern: "*.tmp" }],
      addedBy: "manual",
    });
  });

  it("warns that a path-style global rule only works where the path exists", async () => {
    serve(base());
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Pattern")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "Library/Foo/" } });
    expect(screen.getByTestId("pattern-hint")).toHaveTextContent("path style");
  });

  it("shows the server's reason when a rule is refused", async () => {
    serve(base());
    axios.post.mockRejectedValue({ message: "x", response: { data: { message: "a pattern cannot start with #" } } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Pattern")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "#x" } });
    fireEvent.click(screen.getByText("Add rule"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cannot start with #"));
  });

  it("previews what a pattern matches before it is added", async () => {
    serve(base());
    axios.post.mockResolvedValue({
      data: {
        snapshot: { startTime: "2026-10-23T17:00:00Z" },
        partial: false,
        results: [
          {
            pattern: "node_modules/",
            matches: 7,
            files: 1200,
            bytes: 4500000000,
            top: [{ path: "a/node_modules", isDir: true, size: 800000000, files: 90 }],
          },
        ],
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Pattern")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "node_modules/" } });
    fireEvent.click(screen.getByText("Check what it matches"));

    await waitFor(() => expect(screen.getByText(/would leave out 7 items/)).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith("/api/v1/exclusions/preview", {
      source: "/Applications",
      patterns: ["node_modules/"],
    });
    expect(screen.getByText("a/node_modules/")).toBeInTheDocument();
  });

  it("says when a pattern matches nothing", async () => {
    serve(base());
    axios.post.mockResolvedValue({
      data: {
        snapshot: null,
        partial: false,
        results: [{ pattern: "typo/", matches: 0, files: 0, bytes: 0, top: [] }],
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Pattern")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "typo/" } });
    fireEvent.click(screen.getByText("Check what it matches"));
    await waitFor(() => expect(screen.getByText(/matches nothing/)).toBeInTheDocument());
  });

  it("removes a rule after confirming", async () => {
    serve(base());
    axios.delete.mockResolvedValue({ data: { removed: {}, changes: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByText("node_modules/")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Remove node_modules/"));
    expect(screen.getByText("Remove this rule?")).toBeInTheDocument();
    expect(axios.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith("/api/v1/exclusions/g1"));
    await waitFor(() => expect(screen.getByText(/Removed node_modules\//)).toBeInTheDocument());
  });

  it("offers to fix drift, and only changes the policies after confirming", async () => {
    const data = { ...base(), drift: [{ target: "/Users/me", missing: ["a/", "b/"], extra: [] }] };
    serve(data);
    axios.post.mockResolvedValue({ data: { changes: [{ target: "/Users/me" }] } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/does not follow these rules yet/)).toBeInTheDocument());
    expect(screen.getByText(/\/Users\/me: 2 missing, 0 extra/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Fix"));
    expect(axios.post).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/adds 2, removes 0/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/exclusions/reconcile", {}));
    await waitFor(() => expect(screen.getByText(/now follow the rules/)).toBeInTheDocument());
  });

  it("shows the net rules of a source with where each comes from", async () => {
    serve(base(), {
      "/api/v1/exclusions/net": () =>
        Promise.resolve({
          data: {
            source: "/Applications",
            inSync: true,
            missing: [],
            extra: [],
            rules: [
              { pattern: "node_modules/", from: "global", addedBy: "manual", addedAt: "2026-10-22T10:00:00Z" },
              { pattern: "/Foo.app", from: "source", addedBy: "manual" },
              { pattern: ".Trash/", from: "both", addedBy: "manual" },
            ],
          },
        }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("node_modules/")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("tab-net"));
    await waitFor(() => expect(screen.getByText("/Foo.app")).toBeInTheDocument());
    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("This source")).toBeInTheDocument();
    expect(screen.getByText("Both")).toBeInTheDocument();
    expect(screen.getByText("in force")).toBeInTheDocument();
  });

  it("lists removed rules", async () => {
    serve(base());
    renderPage();
    await waitFor(() => expect(screen.getByText("node_modules/")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tab-removed"));
    expect(screen.getByText(".old/")).toBeInTheDocument();
  });

  it("shows an error with Try again when the rules cannot be loaded", async () => {
    axios.get.mockRejectedValue({ message: "no route to host" });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("no route to host"));
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });
});
