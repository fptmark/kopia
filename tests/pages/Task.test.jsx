import React from "react";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Task } from "../../src/pages/Task";
import { UIPreferencesContext } from "../../src/contexts/UIPreferencesContext";
import { setupAPIMock } from "../testutils/api-mocks";
import "@testing-library/jest-dom";

let axiosMock;

// Mock react-router using unified helper
vi.mock("react-router", async () => {
  const { createRouterMock } = await import("../testutils/react-router-mock.jsx");
  return createRouterMock({
    simple: true,
    location: { pathname: "/tasks/123" },
    params: { tid: "123" },
    navigate: vi.fn(),
  })();
});

// Mock the Logs component to avoid its complex implementation
vi.mock("../../src/components/Logs", () => ({
  Logs: ({ taskID }) => <div data-testid="logs-component">Logs for task {taskID}</div>,
}));

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
 * Helper function to render Task component with necessary providers
 */
const renderTask = (props = {}) => {
  return render(
    <UIPreferencesContext.Provider value={mockUIPreferences}>
      <Task {...props} />
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
});

/**
 * Clean up after each test
 */
afterEach(() => {
  axiosMock.reset();
});

describe("Task component", () => {
  test("shows loading state initially", () => {
    // Mock a delayed response
    axiosMock.onGet("/api/v1/tasks/123").reply(() => {
      return new Promise(() => {
        // Never resolve to keep loading state
      });
    });

    renderTask();
    expect(screen.getByText("Loading ...")).toBeInTheDocument();
  });

  test("displays running task with progress", async () => {
    const runningTask = {
      id: "123",
      kind: "Snapshot",
      description: "Backing up /home/user",
      status: "RUNNING",
      startTime: "2023-01-01T10:00:00Z",
      endTime: null,
      progressInfo: "50% complete",
      counters: {
        files: { value: 100, units: "files", level: "info" },
        bytes: { value: 1024000, units: "bytes", level: "info" },
        errors: { value: 0, units: "errors", level: "error" },
      },
    };

    axiosMock.onGet("/api/v1/tasks/123").reply(200, runningTask);

    renderTask();

    await waitFor(() => {
      expect(screen.getByText(/Running for/)).toBeInTheDocument();
      expect(screen.getByText(/50% complete/)).toBeInTheDocument();
      expect(screen.getByText("Snapshot: Backing up /home/user")).toBeInTheDocument();
    });

    // Check counters are displayed
    expect(screen.getByText("files")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("bytes")).toBeInTheDocument();
  });

  test("displays successful task", async () => {
    const successTask = {
      id: "123",
      kind: "Maintenance",
      description: "Repository maintenance",
      status: "SUCCESS",
      startTime: "2023-01-01T10:00:00Z",
      endTime: "2023-01-01T10:05:00Z",
      progressInfo: "Completed",
      counters: {
        processed: { value: 500, units: "objects", level: "info" },
      },
    };

    axiosMock.onGet("/api/v1/tasks/123").reply(200, successTask);

    renderTask();

    await waitFor(() => {
      expect(screen.getByText(/Task succeeded after/)).toBeInTheDocument();
      expect(screen.getByText("Maintenance: Repository maintenance")).toBeInTheDocument();
    });
  });

  test("displays failed task with error message", async () => {
    const failedTask = {
      id: "123",
      kind: "Restore",
      description: "Restoring files",
      status: "FAILED",
      startTime: "2023-01-01T10:00:00Z",
      endTime: "2023-01-01T10:01:00Z",
      errorMessage: "Permission denied",
      counters: {},
    };

    axiosMock.onGet("/api/v1/tasks/123").reply(200, failedTask);

    renderTask();

    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
      // shown in the summary and again in the expandable full message
      expect(screen.getAllByText(/Permission denied/).length).toBeGreaterThanOrEqual(1);
    });
  });

  test("displays cancel button for running task", async () => {
    const runningTask = {
      id: "123",
      kind: "Snapshot",
      description: "Backing up",
      status: "RUNNING",
      startTime: "2023-01-01T10:00:00Z",
      endTime: null,
      progressInfo: "In progress",
      counters: {},
    };

    axiosMock.onGet("/api/v1/tasks/123").reply(200, runningTask);

    renderTask({ navigate: true });

    await waitFor(() => {
      const stopButton = screen.getByRole("button", { name: /Stop/i });
      expect(stopButton).toBeInTheDocument();
    });
  });

  test("handles API error gracefully", async () => {
    axiosMock.onGet("/api/v1/tasks/123").reply(500, { message: "Server error" });

    renderTask();

    await waitFor(() => {
      expect(screen.getByText("Request failed with status code 500")).toBeInTheDocument();
    });
  });

  test("filters out zero value counters when showZeroCounters is false", async () => {
    const task = {
      id: "123",
      kind: "Snapshot",
      description: "Test task",
      status: "SUCCESS",
      startTime: "2023-01-01T10:00:00Z",
      endTime: "2023-01-01T10:05:00Z",
      counters: {
        files: { value: 100, units: "files", level: "info" },
        errors: { value: 0, units: "errors", level: "error" },
        warnings: { value: 0, units: "warnings", level: "warning" },
      },
    };

    axiosMock.onGet("/api/v1/tasks/123").reply(200, task);

    renderTask({ showZeroCounters: false });

    await waitFor(() => {
      expect(screen.getByText("files")).toBeInTheDocument();
      expect(screen.getByText("100")).toBeInTheDocument();
      // Zero value counters should not be shown
      expect(screen.queryByText("errors")).not.toBeInTheDocument();
      expect(screen.queryByText("warnings")).not.toBeInTheDocument();
    });
  });

  test("shows zero value counters when showZeroCounters is true", async () => {
    const task = {
      id: "123",
      kind: "Snapshot",
      description: "Test task",
      status: "SUCCESS",
      startTime: "2023-01-01T10:00:00Z",
      endTime: "2023-01-01T10:05:00Z",
      counters: {
        files: { value: 100, units: "files", level: "info" },
        errors: { value: 0, units: "errors", level: "error" },
        warnings: { value: 0, units: "warnings", level: "warning" },
      },
    };

    axiosMock.onGet("/api/v1/tasks/123").reply(200, task);

    renderTask({ showZeroCounters: true });

    await waitFor(() => {
      expect(screen.getByText("files")).toBeInTheDocument();
      expect(screen.getByText("100")).toBeInTheDocument();
      // Zero value counters should be shown when showZeroCounters is true
      expect(screen.getByText("errors")).toBeInTheDocument();
      expect(screen.getByText("warnings")).toBeInTheDocument();
      expect(screen.getAllByText("0")).toHaveLength(2);
    });
  });

  test("renders logs component with correct task ID", async () => {
    const task = {
      id: "123",
      kind: "Snapshot",
      description: "Test task",
      status: "SUCCESS",
      startTime: "2023-01-01T10:00:00Z",
      endTime: "2023-01-01T10:05:00Z",
      counters: {},
    };

    axiosMock.onGet("/api/v1/tasks/123").reply(200, task);

    renderTask();

    await waitFor(() => {
      expect(screen.getByTestId("logs-component")).toBeInTheDocument();
      expect(screen.getByText("Logs for task 123")).toBeInTheDocument();
    });
  });

  describe("omitzero field handling", () => {
    test("handles missing value property in counter objects", async () => {
      // Simulate omitzero scenario where value property is omitted from counter
      const task = {
        id: "123",
        kind: "Snapshot",
        description: "Test task",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
        endTime: "2023-01-01T10:05:00Z",
        counters: {
          files: {
            // value property is omitted due to omitzero
            units: "files",
            level: "info",
          },
        },
      };

      axiosMock.onGet("/api/v1/tasks/123").reply(200, task);

      // Should not throw an error when accessing c.value
      renderTask();

      await waitFor(() => {
        expect(screen.getByText("Snapshot: Test task")).toBeInTheDocument();
      });

      // This test will fail until we add proper null checks for counter.value
    });

    test("handles missing units property in counter objects", async () => {
      // Simulate omitzero scenario where units property is omitted from counter
      const task = {
        id: "123",
        kind: "Snapshot",
        description: "Test task",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
        endTime: "2023-01-01T10:05:00Z",
        counters: {
          files: {
            value: 100,
            // units property is omitted due to omitzero
            level: "info",
          },
        },
      };

      axiosMock.onGet("/api/v1/tasks/123").reply(200, task);

      // Should not throw an error when accessing c.units
      renderTask();

      await waitFor(() => {
        expect(screen.getByText("Snapshot: Test task")).toBeInTheDocument();
      });

      // This test will fail until we add proper null checks for counter.units
    });

    test("handles missing level property in counter objects", async () => {
      // Simulate omitzero scenario where level property is omitted from counter
      const task = {
        id: "123",
        kind: "Snapshot",
        description: "Test task",
        status: "SUCCESS",
        startTime: "2023-01-01T10:00:00Z",
        endTime: "2023-01-01T10:05:00Z",
        counters: {
          files: {
            value: 100,
            units: "files",
            // level property is omitted due to omitzero
          },
          errors: {
            value: 0,
            units: "errors",
            // level property is omitted due to omitzero
          },
        },
      };

      axiosMock.onGet("/api/v1/tasks/123").reply(200, task);

      // Should not throw an error when accessing counters[a].level in sortedBadges
      renderTask();

      await waitFor(() => {
        expect(screen.getByText("Snapshot: Test task")).toBeInTheDocument();
      });

      // This test will fail until we add proper null checks for counter.level
    });
  });
});

describe("Task component - failed files of a snapshot", () => {
  const snapshotTask = (status) => ({
    id: "123",
    kind: "Snapshot",
    description: "u@h:/data",
    status,
    startTime: "2026-10-01T10:00:00Z",
    endTime: status === "RUNNING" ? undefined : "2026-10-01T10:05:00Z",
    counters: {},
  });

  test("offers the files that failed, grouped, when the snapshot has recorded errors", async () => {
    axiosMock.onGet("/api/v1/tasks/123").reply(200, snapshotTask("SUCCESS"));
    axiosMock.onGet("/api/v1/tasks/123/errors").reply(200, {
      errors: [
        { path: "Library/Accounts/a", error: "unable to open: open /Users/me/Library/Accounts/a: permission denied" },
        { path: "Library/Accounts/b", error: "unable to open: open /Users/me/Library/Accounts/b: permission denied" },
      ],
    });

    const { FailuresModalHost } = await import("../../src/utils/uiutil");
    const { fireEvent } = await import("@testing-library/react");

    render(
      <UIPreferencesContext.Provider value={mockUIPreferences}>
        <Task />
        <FailuresModalHost />
      </UIPreferencesContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("failed-files-summary")).toBeInTheDocument());
    expect(screen.getByTestId("failed-files-summary")).toHaveTextContent("2 files could not be backed up");

    fireEvent.click(screen.getByTestId("show-failed-files"));

    await waitFor(() => expect(screen.getByTestId("failure-group")).toBeInTheDocument());
    expect(screen.getByTestId("failure-group")).toHaveTextContent("permission denied: ▸ Library/Accounts (2)");
  });

  test("shows nothing extra when no file failed", async () => {
    axiosMock.onGet("/api/v1/tasks/123").reply(200, snapshotTask("SUCCESS"));
    axiosMock.onGet("/api/v1/tasks/123/errors").reply(200, { errors: [] });

    renderTask();

    await waitFor(() => expect(screen.getByText(/Snapshot|SUCCESS|Success/i)).toBeInTheDocument());
    await waitFor(() => expect(axiosMock.history.get.some((r) => r.url === "/api/v1/tasks/123/errors")).toBe(true));
    expect(screen.queryByTestId("failed-files-summary")).toBeNull();
  });

  test("does not look for failed files of tasks that are not snapshots or still run", async () => {
    axiosMock.onGet("/api/v1/tasks/123").reply(200, { ...snapshotTask("SUCCESS"), kind: "Maintenance" });

    renderTask();
    await waitFor(() => expect(screen.getAllByText(/Maintenance/).length).toBeGreaterThan(0));
    expect(axiosMock.history.get.some((r) => r.url.endsWith("/errors"))).toBe(false);
  });

  test("ignores a server without error history", async () => {
    axiosMock.onGet("/api/v1/tasks/123").reply(200, snapshotTask("FAILED"));
    axiosMock.onGet("/api/v1/tasks/123/errors").reply(404);

    renderTask();

    await waitFor(() => expect(axiosMock.history.get.some((r) => r.url === "/api/v1/tasks/123/errors")).toBe(true));
    expect(screen.queryByTestId("failed-files-summary")).toBeNull();
  });
});

describe("Task component - failed task error", () => {
  test("shows the short cause, a hint, and the full message on demand", async () => {
    const full =
      "error opening repository: cannot open storage: unable to dial [h:22]: &ssh.ClientConfig{Config:ssh.Config{}}: " +
      "dial tcp 10.0.0.2:22: connect: no route to host";

    axiosMock.onGet("/api/v1/tasks/123").reply(200, {
      id: "123",
      kind: "Repository",
      description: "Open",
      status: "FAILED",
      startTime: "2023-01-01T10:00:00Z",
      endTime: "2023-01-01T10:00:03Z",
      errorMessage: full,
      counters: {},
    });

    renderTask();

    const box = await screen.findByTestId("task-error");
    expect(box).toHaveTextContent("Error: connect: no route to host");
    expect(box).toHaveTextContent("Local Network permission");
    expect(box.querySelector("details pre").textContent).toBe(full);
  });
});
