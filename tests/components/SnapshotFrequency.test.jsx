import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { intervalSeconds, SnapshotFrequency, splitInterval } from "../../src/components/SnapshotFrequency";

vi.mock("axios");

const POLICY = "/api/v1/policy?userName=&host=&path=";

function renderIt(props = {}) {
  return render(
    <MemoryRouter>
      <SnapshotFrequency {...props} />
    </MemoryRouter>,
  );
}

function mockPolicy(policy = { scheduling: { intervalSeconds: 3600 }, retention: { keepLatest: 5 } }) {
  axios.get.mockResolvedValue({ data: policy });
  axios.put.mockResolvedValue({ data: {} });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("splitInterval / intervalSeconds", () => {
  it("shows whole days as days and anything else in hours", () => {
    expect(splitInterval(3600)).toEqual({ text: "1", unit: "hours" });
    expect(splitInterval(7200)).toEqual({ text: "2", unit: "hours" });
    expect(splitInterval(86400)).toEqual({ text: "1", unit: "days" });
    expect(splitInterval(3 * 86400)).toEqual({ text: "3", unit: "days" });
    expect(splitInterval(36 * 3600)).toEqual({ text: "36", unit: "hours" });
    expect(splitInterval(1800)).toEqual({ text: "0.5", unit: "hours" });
    expect(splitInterval(0)).toEqual({ text: "", unit: "hours" });
  });

  it("turns a typed number and unit into seconds, within 10 minutes to 365 days", () => {
    expect(intervalSeconds("1", "hours")).toBe(3600);
    expect(intervalSeconds("0.5", "hours")).toBe(1800);
    expect(intervalSeconds(" 2 ", "days")).toBe(172800);
    expect(intervalSeconds("365", "days")).toBe(365 * 86400);
    expect(intervalSeconds("0.1", "hours")).toBeNull(); // 6 minutes
    expect(intervalSeconds("366", "days")).toBeNull();
    expect(intervalSeconds("0", "hours")).toBeNull();
    expect(intervalSeconds("-1", "hours")).toBeNull();
    expect(intervalSeconds("abc", "hours")).toBeNull();
    expect(intervalSeconds("", "hours")).toBeNull();
    expect(intervalSeconds("1e3", "hours")).toBeNull();
  });
});

describe("SnapshotFrequency", () => {
  it("shows the frequency in the global policy", async () => {
    mockPolicy();
    renderIt();

    expect(await screen.findByDisplayValue("1")).toBeInTheDocument();
    expect(screen.getByLabelText("Snapshot frequency unit")).toHaveValue("hours");
    expect(axios.get).toHaveBeenCalledWith(POLICY);
  });

  it("shows days for a whole number of days", async () => {
    mockPolicy({ scheduling: { intervalSeconds: 2 * 86400 } });
    renderIt();

    expect(await screen.findByDisplayValue("2")).toBeInTheDocument();
    expect(screen.getByLabelText("Snapshot frequency unit")).toHaveValue("days");
  });

  it("saves a typed number when the field is left, without disturbing the rest of the policy", async () => {
    mockPolicy();
    const onSaved = vi.fn();
    renderIt({ onSaved });

    const input = await screen.findByLabelText("Snapshot frequency");
    await waitFor(() => expect(input).toHaveValue("1"));

    fireEvent.change(input, { target: { value: "6" } });
    expect(axios.put).not.toHaveBeenCalled(); // not on every keystroke
    fireEvent.blur(input);

    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put).toHaveBeenCalledWith(POLICY, {
      scheduling: { intervalSeconds: 21600 },
      retention: { keepLatest: 5 },
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it("saves when the unit changes, and when Enter is pressed", async () => {
    mockPolicy();
    renderIt();

    const input = await screen.findByLabelText("Snapshot frequency");
    await waitFor(() => expect(input).toHaveValue("1"));

    fireEvent.change(screen.getByLabelText("Snapshot frequency unit"), { target: { value: "days" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put.mock.calls[0][1].scheduling.intervalSeconds).toBe(86400);

    fireEvent.change(input, { target: { value: "3" } });
    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(axios.put.mock.calls[1][1].scheduling.intervalSeconds).toBe(3 * 86400);
  });

  it("does not save when nothing changed", async () => {
    mockPolicy();
    renderIt();

    const input = await screen.findByLabelText("Snapshot frequency");
    await waitFor(() => expect(input).toHaveValue("1"));
    fireEvent.blur(input);

    expect(axios.put).not.toHaveBeenCalled();
  });

  it("refuses a value that is not an interval and puts the saved one back", async () => {
    mockPolicy();
    renderIt();

    const input = await screen.findByLabelText("Snapshot frequency");
    await waitFor(() => expect(input).toHaveValue("1"));

    for (const bad of ["0", "abc", "0.01", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.blur(input);
      expect(await screen.findByText(/from 10 minutes to 365 days/)).toBeInTheDocument();
      expect(input).toHaveValue("1");
    }

    expect(axios.put).not.toHaveBeenCalled();
  });

  it("shows why a save failed", async () => {
    mockPolicy();
    axios.put.mockRejectedValue({ response: { data: { message: "repository is read-only" } } });
    renderIt();

    const input = await screen.findByLabelText("Snapshot frequency");
    await waitFor(() => expect(input).toHaveValue("1"));
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.blur(input);

    expect(await screen.findByText(/Not saved: repository is read-only/)).toBeInTheDocument();
  });

  it("creates the global policy's schedule when there is none yet", async () => {
    axios.get.mockRejectedValue({ response: { status: 404 } });
    axios.put.mockResolvedValue({ data: {} });
    renderIt();

    const input = await screen.findByLabelText("Snapshot frequency");
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);

    await waitFor(() => expect(axios.put).toHaveBeenCalledWith(POLICY, { scheduling: { intervalSeconds: 3600 } }));
  });

  it("notes sources that have a schedule of their own", async () => {
    mockPolicy();
    renderIt({ sources: [{ schedule: { intervalSeconds: 3600 } }, { schedule: { intervalSeconds: 21600 } }] });

    expect(await screen.findByText(/some sources have their own schedule/)).toBeInTheDocument();
    cleanup();

    renderIt({ sources: [{ schedule: { intervalSeconds: 3600 } }] });
    await screen.findByDisplayValue("1");
    expect(screen.queryByText(/own schedule/)).not.toBeInTheDocument();
  });
});
