import React from "react";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tasks } from "../../src/pages/Tasks";
import { UIPreferencesContext } from "../../src/contexts/UIPreferencesContext";
import { setupAPIMock } from "../testutils/api-mocks";
import "@testing-library/jest-dom";
import { fireEvent } from "@testing-library/react";
import { setupIntervalMocks, cleanupIntervalMocks, triggerIntervals } from "../testutils/interval-mocks";

let axiosMock;

// Mock react-router Link component using unified helper
vi.mock("react-router", async () => {
  const { createRouterMock } = await import("../testutils/react-router-mock.jsx");
  return createRouterMock({ components: { only: true } })();
});

// Minimal UIPreferences context value
const mockUIPreferences = {
  pageSize: 10,
  theme: "light",
  bytesStringBase2: false,
  defaultSnapshotViewAll: false,
  fontSize: "fs-6",
  setTheme: vi.fn(),
  setPageSize: vi.fn(),
  setByteStringBase: vi.fn(),
  setDefaultSnapshotViewAll: vi.fn(),
  setFontSize: vi.fn(),
};

/**
 * Helper function to render Tasks component with necessary providers
 */
const renderTasks = () => {
  return render(
    <UIPreferencesContext.Provider value={mockUIPreferences}>
      <Tasks />
    </UIPreferencesContext.Provider>,
  );
};

/**
 * Setup API mocks before each test
 */
beforeEach(() => {
  axiosMock = setupAPIMock();
  // Clear all previous mocks
  vi.clearAllMocks();

  // Setup interval mocking
  setupIntervalMocks();
});

/**
 * Clean up after each test
 */
afterEach(() => {
  axiosMock.reset();
  cleanupIntervalMocks();
});

describe("Tasks component", () => {
  test("shows loading state initially", () => {
    // Mock a delayed response
    axiosMock.onGet("/api/v1/tasks").reply(() => {
      return new Promise(() => {
        // Never resolve to keep loading state
      });
    });

    renderTasks();
    expect(screen.getByText("Loading ...")).toBeInTheDocument();
  });

  test("shows info message when no tasks exist", async () => {
    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks: [] });

    renderTasks();

    await waitFor(() => {
      expect(
        screen.getByText(/A list of tasks will appear here when you create snapshots, restore, run maintenance, etc./),
      ).toBeInTheDocument();
    });
  });

  test("displays tasks in table", async () => {
    const tasks = [
      {
        id: "task1",
        kind: "Snapshot",
        description: "Backing up /home/user",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
      },
      {
        id: "task2",
        kind: "Maintenance",
        description: "Repository maintenance",
        status: "RUNNING",
        startTime: "2023-01-01T11:00:00Z",
      },
    ];

    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks });

    renderTasks();

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(screen.getByText("Backing up /home/user")).toBeInTheDocument();
      expect(screen.getByText("Repository maintenance")).toBeInTheDocument();
    });
  });

  test("filters tasks by status", async () => {
    const tasks = [
      {
        id: "task1",
        kind: "Snapshot",
        description: "Task 1",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
      },
      {
        id: "task2",
        kind: "Maintenance",
        description: "Task 2",
        status: "RUNNING",
        startTime: "2023-01-01T11:00:00Z",
      },
      {
        id: "task3",
        kind: "Restore",
        description: "Task 3",
        status: "FAILED",
        startTime: "2023-01-01T12:00:00Z",
      },
    ];

    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks });

    renderTasks();

    await waitFor(() => {
      expect(screen.getByText("Task 1")).toBeInTheDocument();
      expect(screen.getByText("Task 2")).toBeInTheDocument();
      expect(screen.getByText("Task 3")).toBeInTheDocument();
    });

    // Click on the status dropdown
    const statusDropdown = screen.getByText("Status: All");
    await userEvent.click(statusDropdown);

    // Select "Running" status
    const runningOption = screen.getByText("Running");
    await userEvent.click(runningOption);

    // Should only show running tasks
    expect(screen.queryByText("Task 1")).not.toBeInTheDocument();
    expect(screen.getByText("Task 2")).toBeInTheDocument();
    expect(screen.queryByText("Task 3")).not.toBeInTheDocument();
  });

  test("filters tasks by kind", async () => {
    const tasks = [
      {
        id: "task1",
        kind: "Snapshot",
        description: "Snapshot task",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
      },
      {
        id: "task2",
        kind: "Maintenance",
        description: "Maintenance task",
        status: "SUCCESS",
        startTime: "2023-01-01T11:00:00Z",
      },
      {
        id: "task3",
        kind: "Restore",
        description: "Restore task",
        status: "SUCCESS",
        startTime: "2023-01-01T12:00:00Z",
      },
    ];

    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks });

    renderTasks();

    await waitFor(() => {
      expect(screen.getByText("Snapshot task")).toBeInTheDocument();
      expect(screen.getByText("Maintenance task")).toBeInTheDocument();
      expect(screen.getByText("Restore task")).toBeInTheDocument();
    });

    // Click on the kind dropdown
    const kindDropdown = screen.getByText("Kind: All");
    await userEvent.click(kindDropdown);

    // Select "Snapshot" kind - use getAllByText since there are multiple elements
    const snapshotOptions = screen.getAllByText("Snapshot");
    // Click on the dropdown option (not the table content)
    const dropdownOption = snapshotOptions.find((el) => el.classList.contains("dropdown-item"));
    await userEvent.click(dropdownOption);

    // Should only show snapshot tasks
    expect(screen.getByText("Snapshot task")).toBeInTheDocument();
    expect(screen.queryByText("Maintenance task")).not.toBeInTheDocument();
    expect(screen.queryByText("Restore task")).not.toBeInTheDocument();
  });

  test("filters tasks by description search", async () => {
    const tasks = [
      {
        id: "task1",
        kind: "Snapshot",
        description: "Backing up important files",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
      },
      {
        id: "task2",
        kind: "Snapshot",
        description: "Backing up documents",
        status: "SUCCESS",
        startTime: "2023-01-01T11:00:00Z",
      },
      {
        id: "task3",
        kind: "Maintenance",
        description: "Repository cleanup",
        status: "SUCCESS",
        startTime: "2023-01-01T12:00:00Z",
      },
    ];

    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks });

    renderTasks();

    await waitFor(() => {
      expect(screen.getByText("Backing up important files")).toBeInTheDocument();
      expect(screen.getByText("Backing up documents")).toBeInTheDocument();
      expect(screen.getByText("Repository cleanup")).toBeInTheDocument();
    });

    // Search for "documents"
    const searchInput = screen.getByPlaceholderText("search description and errors");
    fireEvent.change(searchInput, { target: { value: "documents" } });

    // Should only show tasks with "documents" in description
    expect(screen.queryByText("Backing up important files")).not.toBeInTheDocument();
    expect(screen.getByText("Backing up documents")).toBeInTheDocument();
    expect(screen.queryByText("Repository cleanup")).not.toBeInTheDocument();
  });

  test("combines multiple filters", async () => {
    const tasks = [
      {
        id: "task1",
        kind: "Snapshot",
        description: "Backing up files",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
      },
      {
        id: "task2",
        kind: "Snapshot",
        description: "Backing up files",
        status: "RUNNING",
        startTime: "2023-01-01T11:00:00Z",
      },
      {
        id: "task3",
        kind: "Maintenance",
        description: "Backing up files",
        status: "RUNNING",
        startTime: "2023-01-01T12:00:00Z",
      },
    ];

    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks });

    renderTasks();

    await waitFor(() => {
      expect(screen.getAllByText("Backing up files")).toHaveLength(3);
    });

    // Set status filter to "Running"
    const statusDropdown = screen.getByText("Status: All");
    await userEvent.click(statusDropdown);
    await userEvent.click(screen.getByText("Running"));

    // Set kind filter to "Snapshot"
    const kindDropdown = screen.getByText("Kind: All");
    await userEvent.click(kindDropdown);
    await userEvent.click(screen.getAllByText("Snapshot")[0]); // Use getAllByText and select the first one

    // Should only show task2 (Snapshot + Running)
    expect(screen.getAllByText("Backing up files")).toHaveLength(1);
    const table = screen.getByRole("table");
    // Count data rows (excluding header row)
    const rows = table.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
  });

  test("handles API error gracefully", async () => {
    axiosMock.onGet("/api/v1/tasks").reply(500, { message: "Server error" });

    renderTasks();

    await waitFor(() => {
      expect(screen.getByText("Request failed with status code 500")).toBeInTheDocument();
    });
  });

  test("refreshes tasks periodically", async () => {
    const initialTasks = [
      {
        id: "task1",
        kind: "Snapshot",
        description: "Initial task",
        status: "RUNNING",
        startTime: "2023-01-01T10:00:00Z",
      },
    ];

    const updatedTasks = [
      {
        id: "task1",
        kind: "Snapshot",
        description: "Initial task",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
      },
      {
        id: "task2",
        kind: "Maintenance",
        description: "New task",
        status: "RUNNING",
        startTime: "2023-01-01T10:05:00Z",
      },
    ];

    // First response
    axiosMock.onGet("/api/v1/tasks").replyOnce(200, { tasks: initialTasks });

    renderTasks();

    await waitFor(() => {
      expect(screen.getByText("Initial task")).toBeInTheDocument();
    });

    // Update mock for next request
    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks: updatedTasks });

    // Trigger the interval callback manually
    await triggerIntervals();

    // Wait for the new task to appear
    await waitFor(() => {
      expect(screen.getByText("New task")).toBeInTheDocument();
    });
  });

  test("task links are rendered with correct structure", async () => {
    // Since we're mocking react-router Link to render as <a href="#">,
    // we can't test the actual routing, but we can test the link structure
    const tasks = [
      {
        id: "task123",
        kind: "Snapshot",
        description: "Test task",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
      },
    ];

    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks });

    renderTasks();

    await waitFor(() => {
      // The real KopiaTable renders links in the task cells
      const links = screen.getAllByRole("link");
      // At least one link should exist
      expect(links.length).toBeGreaterThan(0);
      // The link text is the absolute start time, so older tasks can be audited; the relative time is a tooltip.
      expect(links[0].textContent).toBe("Jan 1, 2023 " + new Date("2023-01-01T10:00:00Z").toLocaleTimeString("en-US"));
      expect(links[0].getAttribute("title")).toMatch(/\d+ years? ago/);
    });
  });
});

describe("Tasks history", () => {
  const T = (n, over = {}) => ({
    id: n.toString(16),
    kind: "Snapshot",
    description: "task " + n,
    status: "SUCCESS",
    startTime: "2026-10-01T10:00:00Z",
    endTime: "2026-10-01T10:01:30Z",
    ...over,
  });

  const lastParams = () => {
    const gets = axiosMock.history.get.filter((r) => r.url === "/api/v1/tasks");
    return gets[gets.length - 1].params;
  };

  test("explains that tasks are kept permanently, with the total", async () => {
    axiosMock
      .onGet("/api/v1/tasks")
      .reply(200, { tasks: [T(2), T(1)], total: 1234, history: true, kinds: ["Snapshot"] });

    renderTasks();

    await waitFor(() => expect(screen.getByTestId("tasks-summary")).toBeInTheDocument());
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("Showing 2 of 1,234 tasks");
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("kept permanently");
  });

  test("warns that tasks are lost on restart when there is no history", async () => {
    axiosMock.onGet("/api/v1/tasks").reply(200, { tasks: [T(1)], total: 1, history: false });

    renderTasks();

    await waitFor(() => expect(screen.getByTestId("tasks-summary")).toHaveTextContent("lost when the server restarts"));
    expect(screen.queryByTestId("load-older-tasks")).toBeNull();
  });

  test("shows how many files each snapshot could not back up, linking to the details", async () => {
    axiosMock.onGet("/api/v1/tasks").reply(200, {
      tasks: [T(2, { description: "with failures", failedFiles: 1431 }), T(1, { description: "clean" })],
      total: 2,
      history: true,
    });

    renderTasks();

    await waitFor(() => expect(screen.getByText("with failures")).toBeInTheDocument());
    const failed = screen.getAllByTestId("task-failed-files");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toHaveTextContent("1,431");
    expect(screen.getByText("Failed files")).toBeInTheDocument();
  });

  test("shows how long each task took", async () => {
    axiosMock.onGet("/api/v1/tasks").reply(200, {
      tasks: [
        T(3, { description: "short", endTime: "2026-10-01T10:00:24Z" }),
        T(2, { description: "medium" }),
        T(1, { description: "long", endTime: "2026-10-01T13:04:10Z" }),
        T(4, { description: "still going", status: "RUNNING", endTime: undefined }),
      ],
      total: 4,
      history: true,
    });

    renderTasks();

    await waitFor(() => expect(screen.getByText("short")).toBeInTheDocument());
    expect(screen.getByText("24s")).toBeInTheDocument();
    expect(screen.getByText("1m 30s")).toBeInTheDocument();
    expect(screen.getByText("3h 4m")).toBeInTheDocument();
  });

  test("asks the server to filter by status, kind, text and dates", async () => {
    axiosMock
      .onGet("/api/v1/tasks")
      .reply(200, { tasks: [T(1)], total: 1, history: true, kinds: ["Maintenance", "Snapshot"] });

    renderTasks();
    await waitFor(() => expect(screen.getByText("task 1")).toBeInTheDocument());
    expect(lastParams()).toEqual({ limit: 100 });

    await userEvent.click(screen.getByText("Status: All"));
    await userEvent.click(screen.getByText("Failed"));
    await waitFor(() => expect(lastParams().status).toBe("FAILED"));

    // kinds come from the server, so they are available even when none are in the current list
    await userEvent.click(screen.getByText("Kind: All"));
    expect(screen.getByText("Maintenance")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Maintenance"));
    await waitFor(() => expect(lastParams().kind).toBe("Maintenance"));

    fireEvent.change(screen.getByTestId("tasks-from"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByTestId("tasks-to"), { target: { value: "2026-10-05" } });
    await waitFor(() => {
      expect(new Date(lastParams().from).getTime()).toBe(new Date("2026-10-01T00:00:00").getTime());
      expect(new Date(lastParams().to).getTime()).toBe(new Date("2026-10-05T23:59:59.999").getTime());
    });

    fireEvent.change(screen.getByPlaceholderText("search description and errors"), { target: { value: "denied" } });
    await waitFor(() => expect(lastParams().q).toBe("denied"), { timeout: 3000 });
    expect(lastParams()).toMatchObject({ status: "FAILED", kind: "Maintenance", q: "denied", limit: 100 });
  });

  test("a failed task shows its short cause and the status opens the task", async () => {
    axiosMock.onGet("/api/v1/tasks").reply(200, {
      tasks: [
        T(2, {
          status: "FAILED",
          kind: "Repository",
          errorMessage: "error opening repository: unable to dial [h:22]: dial tcp 10.0.0.2:22: connect: no route to host",
        }),
        T(1),
      ],
      total: 2,
      history: true,
    });

    renderTasks();
    await waitFor(() => expect(screen.getByText("task 2")).toBeInTheDocument());

    expect(screen.getByTestId("task-error-summary")).toHaveTextContent("connect: no route to host");
    expect(screen.getByTestId("task-error-summary").getAttribute("href")).toBe("/tasks/2");
    expect(screen.getByTestId("task-status-link").getAttribute("href")).toBe("/tasks/2");
    expect(screen.queryAllByTestId("task-error-summary")).toHaveLength(1); // the successful task has none
  });

  test("search matches the error text, ignoring case", async () => {
    axiosMock.onGet("/api/v1/tasks").reply(200, {
      tasks: [T(2, { errorMessage: "open /x: Permission Denied", status: "FAILED" }), T(1)],
      total: 2,
      history: true,
    });

    renderTasks();
    await waitFor(() => expect(screen.getByText("task 2")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("search description and errors"), {
      target: { value: "permission denied" },
    });

    await waitFor(() => expect(screen.queryByText("task 1")).not.toBeInTheDocument());
    expect(screen.getByText("task 2")).toBeInTheDocument();
  });

  test("loads older tasks beyond the first page", async () => {
    const first = [T(5), T(4)];
    const older = [T(3), T(2), T(1)];

    axiosMock.onGet("/api/v1/tasks").reply((config) => {
      if (config.params.before) {
        return [200, { tasks: older, total: 5, history: true }];
      }
      return [200, { tasks: first, total: 5, history: true }];
    });

    renderTasks();
    await waitFor(() => expect(screen.getByText("task 4")).toBeInTheDocument());
    expect(screen.queryByText("task 2")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("load-older-tasks"));

    // continues after the last task shown
    await waitFor(() => expect(screen.getByText("task 2")).toBeInTheDocument());
    const withBefore = axiosMock.history.get.filter((r) => r.params && r.params.before);
    expect(withBefore[0].params.before).toBe("4");

    expect(screen.getByText("task 5")).toBeInTheDocument();
    expect(screen.getByText("task 1")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("Showing 5 of 5 tasks");
    expect(screen.queryByTestId("load-older-tasks")).toBeNull();
  });

  test("a periodic refresh keeps the older tasks that were loaded", async () => {
    axiosMock
      .onGet("/api/v1/tasks")
      .reply((config) =>
        config.params.before
          ? [200, { tasks: [T(1)], total: 3, history: true }]
          : [200, { tasks: [T(3), T(2)], total: 3, history: true }],
      );

    renderTasks();
    await waitFor(() => expect(screen.getByText("task 3")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("load-older-tasks"));
    await waitFor(() => expect(screen.getByText("task 1")).toBeInTheDocument());

    await triggerIntervals();
    await waitFor(() => expect(axiosMock.history.get.filter((r) => !r.params.before).length).toBeGreaterThan(1));

    expect(screen.getByText("task 1")).toBeInTheDocument();
    expect(screen.getByText("task 3")).toBeInTheDocument();
  });

  test("changing a filter drops the older pages", async () => {
    axiosMock
      .onGet("/api/v1/tasks")
      .reply((config) =>
        config.params.before
          ? [200, { tasks: [T(1)], total: 3, history: true }]
          : [200, { tasks: [T(3), T(2)], total: 3, history: true }],
      );

    renderTasks();
    await waitFor(() => expect(screen.getByText("task 3")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("load-older-tasks"));
    await waitFor(() => expect(screen.getByText("task 1")).toBeInTheDocument());

    await userEvent.click(screen.getByText("Status: All"));
    await userEvent.click(screen.getByText("Success"));

    await waitFor(() => expect(screen.queryByText("task 1")).not.toBeInTheDocument());
    expect(screen.getByText("task 3")).toBeInTheDocument();
  });
});

describe("taskQuery and taskDuration", () => {
  test("only sends the filters that are set", async () => {
    const { taskQuery } = await import("../../src/pages/Tasks");
    expect(taskQuery({ showStatus: "All", showKind: "All", searchDescription: "", from: "", to: "" })).toEqual({
      limit: 100,
    });
    expect(
      taskQuery({ showStatus: "Canceled", showKind: "Restore", searchDescription: "x", from: "", to: "" }),
    ).toEqual({
      limit: 100,
      status: "CANCELED",
      kind: "Restore",
      q: "x",
    });
  });

  test("formats durations", async () => {
    const { taskDuration } = await import("../../src/pages/Tasks");
    const t = (end) => ({ startTime: "2026-10-01T10:00:00Z", endTime: end });
    expect(taskDuration({ startTime: "2026-10-01T10:00:00Z" })).toBe("");
    expect(taskDuration(t("2026-10-01T10:00:00Z"))).toBe("0s");
    expect(taskDuration(t("2026-10-01T10:00:59Z"))).toBe("59s");
    expect(taskDuration(t("2026-10-01T10:01:00Z"))).toBe("1m 0s");
    expect(taskDuration(t("2026-10-01T11:00:00Z"))).toBe("1h 0m");
    expect(taskDuration(t("2026-10-01T09:00:00Z"))).toBe("");
  });
});
