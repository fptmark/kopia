import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { MemoryRouter, Route, Routes } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { Preferences } from "../../../src/next/pages/Preferences";
import { About } from "../../../src/next/pages/About";
import { HealthBanner } from "../../../src/next/ui";
import { failuresLabel, newDestination } from "../../../src/next/notifications";

vi.mock("axios");
globalThis.__UI_VERSION__ = "custom-test";

const setters = () => ({
  setTheme: vi.fn(),
  setFontSize: vi.fn(),
  setByteStringBase: vi.fn(),
  setPageSize: vi.fn(),
  setKeepAwake: vi.fn(),
  setVerifyNewData: vi.fn(),
});

const renderPrefs = (search = "", prefs = {}) =>
  render(
    <MemoryRouter initialEntries={["/preferences" + search]}>
      <UIPreferencesContext.Provider
        value={{
          theme: "light",
          fontSize: "fs-6",
          bytesStringBase2: false,
          pageSize: 25,
          keepAwake: "never",
          ...setters(),
          ...prefs,
        }}
      >
        <Routes>
          <Route path="/preferences" element={<Preferences />} />
        </Routes>
      </UIPreferencesContext.Provider>
    </MemoryRouter>,
  );

describe("Preferences page", () => {
  beforeEach(() => {
    axios.get.mockReset().mockResolvedValue({ data: {} });
    axios.post.mockReset().mockResolvedValue({ data: {} });
    axios.put.mockReset().mockResolvedValue({ data: {} });
    axios.delete.mockReset().mockResolvedValue({ data: {} });
  });

  it("opens on Settings and changes them", () => {
    const p = setters();
    renderPrefs("", p);
    expect(screen.getByLabelText("Theme")).toHaveValue("light");

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
    expect(p.setTheme).toHaveBeenCalledWith("dark");
    fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "fs-5" } });
    expect(p.setFontSize).toHaveBeenCalledWith("fs-5");
    fireEvent.change(screen.getByLabelText("Sizes are written in"), { target: { value: "true" } });
    expect(p.setByteStringBase).toHaveBeenCalledWith("true");
    fireEvent.change(screen.getByLabelText("Rows per table page"), { target: { value: "50" } });
    expect(p.setPageSize).toHaveBeenCalledWith(50);
  });

  it("shows a theme from the old UI as light", () => {
    renderPrefs("", { theme: "ocean" });
    expect(screen.getByLabelText("Theme")).toHaveValue("light");
  });

  it("goes to the tab named in the address, and switches tabs", () => {
    const p = setters();
    renderPrefs("", { ...p });
    expect(screen.getByLabelText("Keep the Mac awake during snapshots and checks")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Keep the Mac awake during snapshots and checks"), {
      target: { value: "ac" },
    });
    expect(p.setKeepAwake).toHaveBeenCalledWith("ac");

    fireEvent.click(screen.getByTestId("tab-notifications"));
    expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();
  });

  it("turns on reading back the data each snapshot adds", () => {
    const setVerifyNewData = vi.fn();
    renderPrefs("", { verifyNewData: false, setVerifyNewData });
    expect(screen.getByTestId("verify-new-data")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("verify-new-data"));
    expect(setVerifyNewData).toHaveBeenCalledWith(true);
  });

  it("chooses what to verify after each snapshot", () => {
    const setVerifyEach = vi.fn();
    renderPrefs("", { verifyNewData: true, verifyEachMode: "new", setVerifyEach });
    fireEvent.click(screen.getByLabelText("A sample of the files"));
    expect(setVerifyEach).toHaveBeenCalledWith("sample", 10);
  });

  it("lists ignored errors and removes one", async () => {
    axios.get.mockResolvedValue({
      data: {
        rules: [
          {
            id: "r1",
            source: "/Users/me",
            path: "Library/Accounts",
            scope: "folder",
            kind: "permission",
            hides: 12,
            created: "2026-10-22T10:00:00Z",
            expired: false,
          },
        ],
      },
    });
    renderPrefs("?tab=ignored");
    await waitFor(() => expect(screen.getByText("Library/Accounts")).toBeInTheDocument());
    expect(screen.getByText("permission denied")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove the rule for Library/Accounts"));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith("/api/v1/ignored-errors/r1"));
  });

  it("says when no errors are ignored", async () => {
    renderPrefs("?tab=ignored");
    await waitFor(() => expect(screen.getByText("No errors are ignored.")).toBeInTheDocument());
  });
});

describe("Notifications tab", () => {
  const dest = (over = {}) => ({
    id: "d1",
    type: "imessage",
    name: "iPhone",
    target: "+15550100",
    failures: ["health", "failed"],
    success: { freq: "off" },
    ...over,
  });

  const serve = (destinations = [dest()]) =>
    axios.get.mockImplementation((url) => {
      if (url.endsWith("/destinations")) {
        return Promise.resolve({ data: { repeatSeconds: 43200, destinations } });
      }
      if (url.includes("/log")) {
        return Promise.resolve({
          data: [
            { sentAt: "2026-10-23T10:00:00Z", destination: "d1", event: "failed", status: "sent" },
            {
              sentAt: "2026-10-23T09:00:00Z",
              destination: "d1",
              event: "test",
              status: "failed",
              error: "no Messages",
              attempts: 2,
            },
          ],
        });
      }
      return Promise.resolve({
        data: {
          accounts: [
            { name: "iCloud", addresses: ["a@x.com"] },
            { name: "Work", addresses: ["b@x.com"] },
          ],
        },
      });
    });

  beforeEach(() => {
    axios.get.mockReset();
    axios.put.mockReset().mockResolvedValue({ data: {} });
    axios.post.mockReset().mockResolvedValue({ data: {} });
  });

  it("shows each destination with what it hears about, and the recent messages", async () => {
    serve();
    renderPrefs("?tab=notifications");
    await waitFor(() => expect(screen.getByLabelText("Name of iPhone")).toHaveValue("iPhone"));

    expect(screen.getByLabelText("Send to for iPhone")).toHaveValue("+15550100");
    expect(screen.getByLabelText("Failures for iPhone")).toHaveTextContent("2 of 4 failures");
    await waitFor(() => expect(within(screen.getByTestId("recent-messages")).getByText("Sent")).toBeInTheDocument());
    expect(screen.getByText("no Messages")).toBeInTheDocument();
    expect(screen.getByText("2 tries")).toBeInTheDocument();
  });

  it("saves a change at once, and text only when the field is left", async () => {
    serve();
    renderPrefs("?tab=notifications");
    await waitFor(() => expect(screen.getByLabelText("Send to for iPhone")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Success messages for iPhone"), { target: { value: "now" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put.mock.calls[0][1].destinations[0].success.freq).toBe("now");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Send to for iPhone"), { target: { value: "+15550199" } });
    expect(axios.put).toHaveBeenCalledTimes(1);
    fireEvent.blur(screen.getByLabelText("Send to for iPhone"));
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(axios.put.mock.calls[1][1].destinations[0].target).toBe("+15550199");
    expect(axios.put.mock.calls[1][1].repeatSeconds).toBe(43200);
  });

  it("picks which failures to hear about", async () => {
    serve();
    renderPrefs("?tab=notifications");
    await waitFor(() => expect(screen.getByLabelText("Failures for iPhone")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Failures for iPhone"));
    fireEvent.click(screen.getByLabelText("Snapshot finished with skipped files"));
    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(axios.put.mock.calls[0][1].destinations[0].failures).toEqual(["health", "failed", "skipped"]);
  });

  it("adds a destination, tests one, and deletes one after confirming", async () => {
    serve();
    renderPrefs("?tab=notifications");
    await waitFor(() => expect(screen.getByText("Add destination")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Add destination"));
    fireEvent.click(screen.getByText("This Mac"));
    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(axios.put.mock.calls[0][1].destinations).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("Test iPhone"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/notifications/destinations/d1/test", {}));
    await waitFor(() => expect(screen.getByText("Test message sent to iPhone.")).toBeInTheDocument());

    axios.put.mockClear();
    fireEvent.click(screen.getByLabelText("Delete iPhone"));
    expect(axios.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(axios.put.mock.calls[0][1].destinations.map((d) => d.id)).not.toContain("d1");
  });

  it("explains a failed save or test", async () => {
    serve();
    axios.put.mockRejectedValue({ message: "x", response: { data: { message: "disk full" } } });
    axios.post.mockRejectedValue({ message: "no Messages" });
    renderPrefs("?tab=notifications");
    await waitFor(() => expect(screen.getByLabelText("Success messages for iPhone")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Success messages for iPhone"), { target: { value: "now" } });
    await waitFor(() => expect(screen.getByText("Not saved: disk full")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Test iPhone"));
    await waitFor(() => expect(screen.getByText("Test to iPhone failed: no Messages")).toBeInTheDocument());
  });

  it("offers the sending account of an email destination when Mail has several", async () => {
    serve([dest({ id: "e1", type: "email", name: "Email", target: "me@x.com" })]);
    renderPrefs("?tab=notifications");
    await waitFor(() => expect(screen.getByLabelText("Send from for Email")).toBeInTheDocument());
    expect(screen.getByText("From: iCloud (a@x.com)")).toBeInTheDocument();
  });

  it("says when there are no destinations", async () => {
    serve([]);
    renderPrefs("?tab=notifications");
    await waitFor(() => expect(screen.getByText(/No destinations/)).toBeInTheDocument());
  });

  it("counts failures for the picker label", () => {
    expect(failuresLabel({ failures: [] })).toBe("None");
    expect(failuresLabel(newDestination("mac"))).toBe("All failures");
  });
});

describe("HealthBanner", () => {
  const renderBanner = () =>
    render(
      <MemoryRouter>
        <HealthBanner />
      </MemoryRouter>,
    );

  it("says when the backup failed, verifies the newest snapshots with the usual options, and shows nothing otherwise", async () => {
    axios.get.mockReset().mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/v1/sources"
            ? { sources: [{ lastSnapshot: { id: "s1" } }, { lastSnapshot: { id: "s2" } }, {}] }
            : {
                state: "failing",
                since: "2026-10-23T10:00:00Z",
                checks: [{ name: "Snapshots are recent", ok: false }],
              },
      }),
    );
    axios.post.mockReset().mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/v1/snapshots/verifications" ? { verifications: [], running: [] } : { started: ["s1", "s2"] },
      }),
    );
    const { unmount } = renderBanner();
    await waitFor(() => expect(screen.getByTestId("verify-banner")).toHaveTextContent("Backup failure on"));
    expect(screen.getByText("Details")).toHaveAttribute("href", "/repo");

    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(screen.getByTestId("verify-dialog")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("A sample of the files"));
    fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith("/api/v1/snapshots/verify", {
        snapshotIds: ["s1", "s2"],
        mode: "sample",
        percent: 10,
      }),
    );
    unmount();

    axios.get.mockResolvedValue({ data: { state: "ok", checks: [] } });
    renderBanner();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("verify-banner")).not.toBeInTheDocument();
  });

  it("stays out of the way when the status cannot be read", async () => {
    axios.get.mockReset().mockRejectedValue(new Error("down"));
    renderBanner();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("verify-banner")).not.toBeInTheDocument();
  });
});

describe("About page", () => {
  it("shows the versions and what this build adds", () => {
    render(
      <MemoryRouter>
        <UIPreferencesContext.Provider value={{ pageSize: 25 }}>
          <About />
        </UIPreferencesContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("about-ui-version")).toHaveTextContent("custom-test");
    expect(screen.getByText("Server version")).toBeInTheDocument();
    expect(screen.getByText(/Exclusions: global and per-source rules/)).toBeInTheDocument();
  });
});
