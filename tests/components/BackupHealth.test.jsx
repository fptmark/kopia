import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { BackupHealthPanel, VerifyBanner } from "../../src/components/BackupHealth";
import { UIPreferencesContext } from "../../src/contexts/UIPreferencesContext";

vi.mock("axios");

const failing = {
  enabled: true,
  state: "failing",
  since: "2026-10-22T10:00:00Z",
  lastRun: "2026-10-22T10:10:00Z",
  checks: [
    { name: "Snapshots are recent", ok: true, detail: "fine" },
    { name: "Snapshots skip no unexpected files", ok: false, detail: "/Users/me: 144 files could not be backed up" },
  ],
};

const healthy = {
  enabled: true,
  state: "ok",
  since: "2026-10-22T09:00:00Z",
  lastDeepRun: "2026-10-22T03:00:00Z",
  lastDeepTaskId: "2a",
  checks: [{ name: "A random file restores identically", ok: true, detail: "matches" }],
};

function renderWithRouter(ui, prefs = {}) {
  return render(
    <MemoryRouter>
      <UIPreferencesContext value={{ verifierIMessageTo: "", setVerifierIMessageTo: vi.fn(), ...prefs }}>
        {ui}
      </UIPreferencesContext>
    </MemoryRouter>,
  );
}

afterEach(() => vi.resetAllMocks());

describe("VerifyBanner", () => {
  it("shows the failed checks when the backup health fails", async () => {
    axios.get.mockResolvedValue({ data: failing });
    renderWithRouter(<VerifyBanner />);

    expect(await screen.findByTestId("verify-banner")).toBeInTheDocument();
    expect(screen.getByText(/144 files could not be backed up/)).toBeInTheDocument();
    expect(screen.queryByText(/fine/)).not.toBeInTheDocument(); // passing checks are not listed
  });

  it("shows nothing when healthy, unknown, or when the status cannot be read", async () => {
    axios.get.mockResolvedValue({ data: healthy });
    const { unmount } = renderWithRouter(<VerifyBanner />);
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(screen.queryByTestId("verify-banner")).not.toBeInTheDocument();
    unmount();

    axios.get.mockRejectedValue(new Error("down"));
    renderWithRouter(<VerifyBanner />);
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("verify-banner")).not.toBeInTheDocument();
  });
});

describe("BackupHealthPanel", () => {
  it("lists every check with its result", async () => {
    axios.get.mockResolvedValue({ data: failing });
    renderWithRouter(<BackupHealthPanel />);

    expect(await screen.findByText(/Failing since/)).toBeInTheDocument();
    expect(screen.getByText("Snapshots are recent")).toBeInTheDocument();
    expect(screen.getByText("Snapshots skip no unexpected files")).toBeInTheDocument();
  });

  it("links to the last full check", async () => {
    axios.get.mockResolvedValue({ data: healthy });
    renderWithRouter(<BackupHealthPanel />);

    const link = await screen.findByText("details");
    expect(link.getAttribute("href")).toBe("/tasks/2a");
  });

  it("saves the iMessage recipient when the field loses focus", async () => {
    axios.get.mockResolvedValue({ data: healthy });
    const setVerifierIMessageTo = vi.fn();
    renderWithRouter(<BackupHealthPanel />, { setVerifierIMessageTo });

    const input = await screen.findByPlaceholderText(/phone number or Apple ID/);
    fireEvent.change(input, { target: { value: " +15551234567 " } });
    expect(setVerifierIMessageTo).not.toHaveBeenCalled(); // not on every keystroke
    fireEvent.blur(input);
    expect(setVerifierIMessageTo).toHaveBeenCalledWith("+15551234567");
  });

  it("starts a full check and sends a test message", async () => {
    axios.get.mockResolvedValue({ data: healthy });
    axios.post.mockResolvedValue({ data: {} });
    renderWithRouter(<BackupHealthPanel />);

    fireEvent.click(await screen.findByText("Run full check now"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/verify/run", {}));
    expect(await screen.findByText("Check started.")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Send test message"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/verify/test-notification", {}));
    expect(await screen.findByText("Test message sent.")).toBeInTheDocument();
  });
});
