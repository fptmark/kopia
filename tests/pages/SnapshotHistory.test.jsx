import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SnapshotHistory } from "../../src/pages/SnapshotHistory";
import { BrowserRouter } from "react-router";
import axios from "axios";
import { UIPreferencesContext } from "../../src/contexts/UIPreferencesContext";
import { mockNavigate, resetRouterMocks } from "../testutils/react-router-mock.jsx";

// Mock axios
vi.mock("axios");

// Mock react-router using the unified helper with custom location
vi.mock("react-router", async () => {
  const { createRouterMock } = await import("../testutils/react-router-mock.jsx");
  return createRouterMock({
    location: {
      search: "?host=testhost&userName=testuser&path=/test/path",
    },
  })();
});

// Helper function to render component with required providers
const renderWithProviders = (component, extraPrefs = {}) => {
  const mockUIPreferences = {
    theme: "light",
    showIdenticalSnapshots: false,
    setShowIdenticalSnapshots: vi.fn(),
    bytesStringBase2: vi.fn((size) => `${size} bytes`), // Mock function for size formatting
    ...extraPrefs,
  };

  return render(
    <BrowserRouter>
      <UIPreferencesContext.Provider value={mockUIPreferences}>{component}</UIPreferencesContext.Provider>
    </BrowserRouter>,
  );
};

describe("SnapshotHistory", () => {
  beforeEach(() => {
    resetRouterMocks();
    vi.clearAllMocks();
    axios.get.mockReset();
    axios.post.mockReset();
  });

  it("should render loading spinner initially", () => {
    axios.get.mockImplementation(() => new Promise(() => {})); // Never resolves
    renderWithProviders(<SnapshotHistory />);

    // Look for Bootstrap spinner div
    expect(document.querySelector(".spinner-border")).toBeInTheDocument();
  });

  it("should fetch and display snapshots on mount", async () => {
    const mockResponse = {
      data: {
        snapshots: [
          {
            id: "snap1",
            startTime: "2023-01-01T12:00:00Z",
            rootOid: "root1",
            tags: {
              hostname: "testhost",
              username: "testuser",
              path: "/test/path",
            },
            summary: {
              totalSize: 104857600, // 100 MB
              fileCount: 100,
              dirCount: 10,
            },
            retention: {
              days: 30,
            },
            pins: [],
          },
        ],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByText(/Displaying.*1.*snapshots/)).toBeInTheDocument();
    });

    // Check that basic elements are rendered
    expect(screen.getByText("testuser@testhost:/test/path")).toBeInTheDocument();
    expect(screen.getByText("Return")).toBeInTheDocument();
    expect(screen.getByText("Select All")).toBeInTheDocument();
  });

  describe("sizes and storage cost", () => {
    const snap = (id, startTime, size, files) => ({
      id,
      startTime,
      rootID: "root" + id,
      summary: { size, files, dirs: 10 },
      retention: [],
      pins: [],
    });

    const mockAPI = (storage) => {
      axios.get.mockImplementation((url) => {
        if (url.startsWith("/api/v1/snapshots/storage-stats")) {
          return storage instanceof Error ? Promise.reject(storage) : Promise.resolve({ data: { snapshots: storage } });
        }

        return Promise.resolve({
          data: {
            snapshots: [
              snap("s3", "2023-01-03T12:00:00Z", 1_300_000_000_000, 1311967),
              snap("s2", "2023-01-02T12:00:00Z", 205_000_000_000, 674000),
              snap("s1", "2023-01-01T12:00:00Z", 204_000_000_000, 673000),
            ],
            unfilteredCount: 3,
            uniqueCount: 3,
          },
        });
      });
    };

    it("shows what each snapshot added and the stored total", async () => {
      mockAPI([
        { id: "s1", newBytes: 150_000_000_000, newFiles: 673000, newDirs: 100 },
        { id: "s2", newBytes: 5_000_000, newFiles: 10, newDirs: 1 },
        { id: "s3", newBytes: 7_000_000, newFiles: 20, newDirs: 2 },
      ]);
      renderWithProviders(<SnapshotHistory />, { pageSize: 20 });

      await waitFor(() => {
        expect(screen.getByTitle("20 new files, 2 new dirs")).toBeInTheDocument();
      });

      expect(axios.get).toHaveBeenCalledWith(expect.stringContaining("/api/v1/snapshots/storage-stats?"));
      expect(screen.getByTitle("10 new files, 1 new dirs")).toBeInTheDocument();
      expect(screen.getByTestId("history-summary")).toHaveTextContent("stored size of all snapshots");
    });

    it("keeps Delete visible but disabled until a snapshot is selected, and Compare needs two", async () => {
      mockAPI([]);
      renderWithProviders(<SnapshotHistory />, { pageSize: 20 });

      await waitFor(() => {
        expect(screen.getAllByRole("checkbox").length).toBeGreaterThanOrEqual(3);
      });

      const del = screen.getByRole("button", { name: /Delete Selected/ });
      const compare = screen.getByRole("button", { name: "Compare" });
      expect(del).toBeDisabled();
      expect(compare).toBeDisabled();

      // rows are re-created on every change, so look the boxes up again each time
      const boxes = () => screen.getAllByRole("checkbox").filter((b) => b.classList.contains("form-check-input"));
      fireEvent.click(boxes()[0]);
      expect(screen.getByRole("button", { name: /Delete Selected \(1\)/ })).toBeEnabled();
      expect(compare).toBeDisabled();

      // rows are newest first: s3, s2, s1
      fireEvent.click(boxes()[2]);
      expect(compare).toBeEnabled();

      fireEvent.click(compare);
      expect(mockNavigate).toHaveBeenCalledWith("/snapshots/diff?from=s1&to=s3");
    });

    it("shortens file counts", async () => {
      mockAPI([]);
      renderWithProviders(<SnapshotHistory />, { pageSize: 20 });

      await waitFor(() => {
        expect(screen.getByTitle("1311967")).toHaveTextContent("1.3M");
      });
    });

    it("marks a large jump in logical size against the previous snapshot", async () => {
      mockAPI([]);
      renderWithProviders(<SnapshotHistory />, { pageSize: 20 });

      await waitFor(() => {
        expect(screen.getAllByTestId("size-jump")).toHaveLength(1);
      });

      expect(screen.getByTestId("size-jump")).toHaveAttribute(
        "title",
        expect.stringContaining("Logical size changed by +"),
      );
    });

    it("still lists snapshots when the storage stats fail", async () => {
      mockAPI(new Error("boom"));
      renderWithProviders(<SnapshotHistory />, { pageSize: 20 });

      await waitFor(() => {
        expect(screen.getByText(/Displaying.*3.*snapshots/)).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getAllByText("\u2014").length).toBe(3);
      });
      expect(screen.getByTestId("history-summary")).not.toHaveTextContent("stored size");
    });
  });

  it("should handle refresh button click", async () => {
    const mockResponse = {
      data: {
        snapshots: [],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByTitle("Fetch snapshots")).toBeInTheDocument();
    });

    const refreshButton = screen.getByTitle("Fetch snapshots");

    act(() => {
      fireEvent.click(refreshButton);
    });

    // Wait for the API to be called again (each load fetches the list, then the storage stats)
    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledTimes(4);
    });
  });

  it("should display error when fetch fails", async () => {
    axios.get.mockRejectedValue(new Error("Network error"));

    // Mock console.error to avoid error output in tests
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });

    consoleSpy.mockRestore();
  });

  it("should handle empty snapshot list", async () => {
    const mockResponse = {
      data: {
        snapshots: [],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByText(/Displaying.*0.*snapshots/)).toBeInTheDocument();
    });
  });

  it("should show return button and navigate on click", async () => {
    const mockResponse = {
      data: {
        snapshots: [],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByText("Return")).toBeInTheDocument();
    });

    const returnButton = screen.getByText("Return");
    fireEvent.click(returnButton);

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it("should render table with correct headers", async () => {
    const mockResponse = {
      data: {
        snapshots: [],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByText("Selected")).toBeInTheDocument();
    });

    // Check all table headers
    expect(screen.getByText("Start time")).toBeInTheDocument();
    expect(screen.getByText("Root")).toBeInTheDocument();
    expect(screen.getByText("Retention")).toBeInTheDocument();
    expect(screen.getByText("Logical size")).toBeInTheDocument();
    expect(screen.getByText("New data")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Dirs")).toBeInTheDocument();
  });

  it("should render CLI command button", async () => {
    const mockResponse = {
      data: {
        snapshots: [],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByTestId("show-cli-button")).toBeInTheDocument();
    });
  });

  it("should handle network requests with correct parameters", async () => {
    const mockResponse = {
      data: {
        snapshots: [],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/snapshots?userName=testuser&host=testhost&path=%2Ftest%2Fpath"),
      );
    });
  });

  it("should display snapshot count in header", async () => {
    const mockResponse = {
      data: {
        snapshots: [
          {
            id: "snap1",
            startTime: "2023-01-01T12:00:00Z",
            rootOid: "root1",
            tags: {
              hostname: "testhost",
              username: "testuser",
              path: "/test/path",
            },
            summary: {
              totalSize: 104857600,
              size: 104857600, // Add this for table compatibility
              fileCount: 100,
              dirCount: 10,
            },
            retention: {
              days: 30,
            },
            pins: [],
          },
          {
            id: "snap2",
            startTime: "2023-01-02T12:00:00Z",
            rootOid: "root2",
            tags: {
              hostname: "testhost",
              username: "testuser",
              path: "/test/path",
            },
            summary: {
              totalSize: 209715200,
              size: 209715200, // Add this for table compatibility
              fileCount: 200,
              dirCount: 20,
            },
            retention: {
              days: 30,
            },
            pins: [],
          },
        ],
      },
    };

    axios.get.mockResolvedValue(mockResponse);
    renderWithProviders(<SnapshotHistory />);

    await waitFor(() => {
      expect(screen.getByText(/Displaying.*2.*snapshots/)).toBeInTheDocument();
    });
  });

  describe("Snapshot Deletion", () => {
    const mockSnapshotsResponse = {
      data: {
        snapshots: [
          {
            id: "snap1",
            startTime: "2023-01-01T12:00:00Z",
            rootOid: "root1",
            tags: {
              hostname: "testhost",
              username: "testuser",
              path: "/test/path",
            },
            summary: {
              totalSize: 104857600,
              size: 104857600,
              fileCount: 100,
              dirCount: 10,
            },
            retention: {
              days: 30,
            },
            pins: [],
            description: "Test snapshot 1",
          },
          {
            id: "snap2",
            startTime: "2023-01-02T12:00:00Z",
            rootOid: "root2",
            tags: {
              hostname: "testhost",
              username: "testuser",
              path: "/test/path",
            },
            summary: {
              totalSize: 209715200,
              size: 209715200,
              fileCount: 200,
              dirCount: 20,
            },
            retention: {
              days: 30,
            },
            pins: [],
            description: "Test snapshot 2",
          },
        ],
        unfilteredCount: 2,
        uniqueCount: 2,
      },
    };

    it("should show delete source button when no snapshots exist", async () => {
      const emptyResponse = {
        data: {
          snapshots: [],
          unfilteredCount: 0,
          uniqueCount: 0,
        },
      };

      axios.get.mockResolvedValue(emptyResponse);
      renderWithProviders(<SnapshotHistory />);

      await waitFor(() => {
        expect(screen.getByText("Delete Snapshot Source")).toBeInTheDocument();
      });
    });

    it("should delete snapshot source when no snapshots exist", async () => {
      const emptyResponse = {
        data: {
          snapshots: [],
          unfilteredCount: 0,
          uniqueCount: 0,
        },
      };

      axios.get.mockResolvedValue(emptyResponse);
      axios.post.mockResolvedValue({ data: { success: true } });
      renderWithProviders(<SnapshotHistory />);

      await waitFor(() => {
        expect(screen.getByText("Delete Snapshot Source")).toBeInTheDocument();
      });

      const deleteSourceButton = screen.getByText("Delete Snapshot Source");
      fireEvent.click(deleteSourceButton);

      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith("/api/v1/snapshots/delete", {
          source: {
            host: "testhost",
            userName: "testuser",
            path: "/test/path",
          },
          deleteSourceAndPolicy: true,
        });
      });
    });

    it("should display select all button when snapshots exist", async () => {
      axios.get.mockResolvedValue(mockSnapshotsResponse);
      renderWithProviders(<SnapshotHistory />);

      await waitFor(() => {
        expect(screen.getByText("Select All")).toBeInTheDocument();
      });

      // Should not show delete source button when snapshots exist
      expect(screen.queryByText("Delete Snapshot Source")).not.toBeInTheDocument();
    });

    it("should show correct snapshot count", async () => {
      axios.get.mockResolvedValue(mockSnapshotsResponse);
      renderWithProviders(<SnapshotHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Displaying.*2.*snapshots/)).toBeInTheDocument();
      });
    });

    it("should show table headers for snapshot data", async () => {
      axios.get.mockResolvedValue(mockSnapshotsResponse);
      renderWithProviders(<SnapshotHistory />);

      await waitFor(() => {
        expect(screen.getByText("Selected")).toBeInTheDocument();
        expect(screen.getByText("Start time")).toBeInTheDocument();
        expect(screen.getByText("Root")).toBeInTheDocument();
        expect(screen.getByText("Retention")).toBeInTheDocument();
        expect(screen.getByText("Logical size")).toBeInTheDocument();
        expect(screen.getByText("New data")).toBeInTheDocument();
        expect(screen.getByText("Files")).toBeInTheDocument();
        expect(screen.getByText("Dirs")).toBeInTheDocument();
      });
    });

    it("should handle delete API errors gracefully", async () => {
      const emptyResponse = {
        data: {
          snapshots: [],
          unfilteredCount: 0,
          uniqueCount: 0,
        },
      };

      axios.get.mockResolvedValue(emptyResponse);
      axios.post.mockRejectedValue(new Error("Delete failed"));

      // Mock console.error to avoid test output noise
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      renderWithProviders(<SnapshotHistory />);

      await waitFor(() => {
        expect(screen.getByText("Delete Snapshot Source")).toBeInTheDocument();
      });

      const deleteSourceButton = screen.getByText("Delete Snapshot Source");
      fireEvent.click(deleteSourceButton);

      // API should be called
      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith("/api/v1/snapshots/delete", expect.any(Object));
      });

      consoleErrorSpy.mockRestore();
    });

    it("should call correct API when deleting source with no snapshots", async () => {
      const emptyResponse = {
        data: {
          snapshots: [],
          unfilteredCount: 0,
          uniqueCount: 0,
        },
      };

      axios.get.mockResolvedValue(emptyResponse);
      axios.post.mockResolvedValue({ data: { success: true } });
      renderWithProviders(<SnapshotHistory />);

      await waitFor(() => {
        expect(screen.getByText("Delete Snapshot Source")).toBeInTheDocument();
      });

      const deleteSourceButton = screen.getByText("Delete Snapshot Source");
      fireEvent.click(deleteSourceButton);

      // Should use snapshots/delete endpoint with deleteSourceAndPolicy flag
      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith("/api/v1/snapshots/delete", {
          source: {
            host: "testhost",
            userName: "testuser",
            path: "/test/path",
          },
          deleteSourceAndPolicy: true,
        });
      });

      // Should NOT call the sources/delete endpoint
      expect(axios.post).not.toHaveBeenCalledWith("/api/v1/sources/delete", expect.any(Object));
    });
  });

  describe("omitzero field handling", () => {
    it("should handle missing summary field when omitzero omits it", async () => {
      // Simulate omitzero scenario where summary field is omitted
      const mockResponse = {
        data: {
          snapshots: [
            {
              id: "snap1",
              startTime: "2023-01-01T12:00:00Z",
              rootID: "root1",
              // summary field is omitted due to omitzero
              retention: [],
              pins: [],
            },
          ],
          unfilteredCount: 1,
          uniqueCount: 1,
        },
      };

      axios.get.mockResolvedValue(mockResponse);
      renderWithProviders(<SnapshotHistory />);

      // Should not throw an error and should render the table
      await waitFor(() => {
        expect(screen.getByRole("table")).toBeInTheDocument();
      });

      // The size, files, and dirs columns should handle missing summary gracefully
      // This test will fail until we add proper null checks
    });

    it("should handle missing pins field when omitzero omits it", async () => {
      // Simulate omitzero scenario where pins field is omitted
      const mockResponse = {
        data: {
          snapshots: [
            {
              id: "snap1",
              startTime: "2023-01-01T12:00:00Z",
              rootID: "root1",
              summary: {
                size: 104857600,
                files: 100,
                dirs: 10,
              },
              retention: [],
              // pins field is omitted due to omitzero
            },
          ],
          unfilteredCount: 1,
          uniqueCount: 1,
        },
      };

      axios.get.mockResolvedValue(mockResponse);
      renderWithProviders(<SnapshotHistory />);

      // Should not throw an error when trying to map over pins
      await waitFor(() => {
        expect(screen.getByRole("table")).toBeInTheDocument();
      });

      // This test will fail until we add proper null checks for pins
    });
  });
});
