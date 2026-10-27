import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { FailedFilesDialog, ignoreChoices } from "../../../src/next/ui/FailedFiles";

vi.mock("axios");

const summ = {
  source: "/Users/me",
  numFailed: 3,
  errors: [
    { path: "/Users/me/Library/Logi/sentry/1.run", error: "permission denied", kind: "permission" },
    { path: "/Users/me/Library/Logi/sentry/2.run", error: "permission denied", kind: "permission" },
    { path: "/Users/me/Library/Other/x", error: "permission denied", kind: "permission" },
  ],
};

const show = () =>
  render(
    <MemoryRouter>
      <FailedFilesDialog summ={summ} onClose={() => {}} />
    </MemoryRouter>,
  );

describe("FailedFilesDialog excluded paths", () => {
  beforeEach(() => {
    axios.get.mockReset().mockResolvedValue({ data: {} });
    axios.post.mockReset();
  });

  it("asks which paths the rules cover and disables the buttons for those", async () => {
    axios.post.mockResolvedValue({
      data: { covered: [{ path: "/Users/me/Library/Logi/sentry/1.run", pattern: "sentry/" }] },
    });
    show();
    expect(axios.post.mock.calls[0][0]).toBe("/api/v1/exclusions/covered");
    expect(axios.post.mock.calls[0][1]).toEqual({ source: "/Users/me", paths: summ.errors.map((e) => e.path) });

    const groups = screen.getAllByTestId("failure-group");
    for (const g of groups) {
      fireEvent.click(g.querySelector("button[aria-expanded]"));
    }
    await waitFor(() => expect(screen.getByTestId("file-excluded")).toHaveTextContent("Excluded by sentry/"));

    const row = screen.getByTestId("file-excluded").closest("li");
    expect(row.querySelectorAll("button:disabled")).toHaveLength(2);

    // the other file in the same folder, and the group, stay active
    const other = screen.getByText("/Users/me/Library/Logi/sentry/2.run").closest("li");
    expect(other.querySelectorAll("button:disabled")).toHaveLength(0);
    expect(screen.queryByTestId("group-excluded")).toBeNull();
  });

  it("disables the group buttons when every file in the group is covered", async () => {
    axios.post.mockResolvedValue({
      data: {
        covered: summ.errors.map((e) => ({ path: e.path, pattern: "Library/" })),
      },
    });
    show();
    await waitFor(() => expect(screen.getAllByTestId("group-excluded").length).toBeGreaterThan(0));
    for (const g of screen.getAllByTestId("failure-group")) {
      expect(g.querySelectorAll("button:disabled").length).toBeGreaterThan(0);
    }
  });

  it("leaves the buttons active when the lookup fails", async () => {
    axios.post.mockRejectedValue({ message: "boom" });
    show();
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(document.querySelectorAll("button:disabled")).toHaveLength(0);
  });
});

describe("ignoreChoices", () => {
  it("offers the kind of error under a folder first, then any error", () => {
    expect(ignoreChoices({ path: "Library/a", kind: "permission", file: false }).map((c) => c.rule)).toEqual([
      { path: "Library/a", scope: "folder", kind: "permission" },
      { path: "Library/a", scope: "folder" },
    ]);
  });

  it("offers a file by itself first", () => {
    expect(ignoreChoices({ path: "a/b", kind: "permission", file: true }).map((c) => c.rule)).toEqual([
      { path: "a/b", scope: "file" },
      { path: "a/b", scope: "folder" },
    ]);
  });
});
