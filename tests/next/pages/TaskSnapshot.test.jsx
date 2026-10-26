import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { TaskSnapshot } from "../../../src/next/pages/TaskSnapshot";

vi.mock("axios");

const Where = () => {
  const l = useLocation();
  return (
    <div data-testid="where">
      {l.pathname + (l.state?.snapshot ? " " + l.state.snapshot.id + "<" + l.state.snapshot.previousId : "")}
    </div>
  );
};

const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/snapshots/of-task/t1"]}>
      <Routes>
        <Route path="/snapshots/of-task/:tid" element={<TaskSnapshot />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

const serve = (errors, snapshots = []) =>
  axios.get.mockImplementation((url) =>
    Promise.resolve({ data: String(url).endsWith("/errors") ? errors : { snapshots } }),
  );

describe("TaskSnapshot", () => {
  beforeEach(() => axios.get.mockReset());

  it("opens the snapshot the task made, knowing which one came before it", async () => {
    serve({ errors: [], source: "/Users/me", userName: "me", host: "mac", snapshotId: "s2" }, [
      { id: "s1", rootID: "kold", startTime: "2026-10-26T13:00:00Z" },
      { id: "s2", rootID: "knew", startTime: "2026-10-26T14:00:00Z" },
    ]);
    renderIt();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/snapshots/dir/knew s2<s1"));
  });

  it("shows the task when it made no snapshot", async () => {
    serve({ errors: [], source: "/Users/me", userName: "me", host: "mac" });
    renderIt();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/tasks/t1"));
  });

  it("shows the task when the snapshot is no longer there", async () => {
    serve({ errors: [], source: "/Users/me", userName: "me", host: "mac", snapshotId: "gone" }, []);
    renderIt();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/tasks/t1"));
  });
});
