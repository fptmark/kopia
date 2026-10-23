import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { SnapshotFrequency } from "../../src/components/SnapshotFrequency";

vi.mock("axios");

const POLICY = "/api/v1/policy?userName=&host=&path=";

const press = (el, key) => fireEvent.keyDown(el, { key });
const typeKeys = (el, keys) => [...keys].forEach((k) => press(el, k));
const leave = (el) => fireEvent.blur(el);

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

const value = () => screen.getByLabelText("Snapshot frequency value");
const unit = () => screen.getByLabelText("Snapshot frequency unit");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("SnapshotFrequency", () => {
  it("shows the frequency in the global policy as a number and a unit", async () => {
    mockPolicy();
    renderIt();

    await waitFor(() => expect(value()).toHaveTextContent("1"));
    expect(unit()).toHaveTextContent("hr");
    expect(axios.get).toHaveBeenCalledWith(POLICY);
  });

  it("shows minutes for a period that is not whole hours, and days for whole days", async () => {
    mockPolicy({ scheduling: { intervalSeconds: 5400 } });
    const { unmount } = renderIt();
    await waitFor(() => expect(value()).toHaveTextContent("90"));
    expect(unit()).toHaveTextContent("min");
    unmount();

    mockPolicy({ scheduling: { intervalSeconds: 2 * 86400 } });
    renderIt();
    await waitFor(() => expect(value()).toHaveTextContent("2"));
    expect(unit()).toHaveTextContent("days");
  });

  it("saves an edit when the field is left, without disturbing the rest of the policy", async () => {
    mockPolicy();
    const onSaved = vi.fn();
    renderIt({ onSaved });

    await waitFor(() => expect(value()).toHaveTextContent("1"));
    typeKeys(value(), "6");
    expect(axios.put).not.toHaveBeenCalled(); // not on every key

    leave(value());
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put).toHaveBeenCalledWith(POLICY, {
      scheduling: { intervalSeconds: 21600 },
      retention: { keepLatest: 5 },
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it("saves a new unit and when Enter is pressed", async () => {
    mockPolicy();
    renderIt();

    await waitFor(() => expect(value()).toHaveTextContent("1"));
    press(unit(), "d");
    leave(unit());
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put.mock.calls[0][1].scheduling.intervalSeconds).toBe(86400);

    value().focus(); // Enter leaves the part that has the focus
    typeKeys(value(), "3");
    press(value(), "Enter");
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(axios.put.mock.calls[1][1].scheduling.intervalSeconds).toBe(3 * 86400);
  });

  it("accepts minutes, and refuses less than a minute", async () => {
    mockPolicy();
    renderIt();

    await waitFor(() => expect(value()).toHaveTextContent("1"));
    press(unit(), "m");
    leave(unit());
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put.mock.calls[0][1].scheduling.intervalSeconds).toBe(60);

    press(unit(), "s");
    leave(unit());
    expect(await screen.findByText(/at least 1 minute, at most 365 days/)).toBeInTheDocument();
    expect(axios.put).toHaveBeenCalledTimes(1);
    expect(unit()).toHaveTextContent("min");
  });

  it("does not save when nothing changed", async () => {
    mockPolicy();
    renderIt();

    await waitFor(() => expect(value()).toHaveTextContent("1"));
    typeKeys(value(), "1");
    leave(value());

    expect(axios.put).not.toHaveBeenCalled();
  });

  it("clears the frequency when the number is erased, leaving the rest of the policy", async () => {
    mockPolicy();
    renderIt();

    await waitFor(() => expect(value()).toHaveTextContent("1"));
    press(value(), "Backspace");
    leave(value());

    await waitFor(() =>
      expect(axios.put).toHaveBeenCalledWith(POLICY, { scheduling: {}, retention: { keepLatest: 5 } }),
    );
  });

  it("shows why a save failed", async () => {
    mockPolicy();
    axios.put.mockRejectedValue({ response: { data: { message: "repository is read-only" } } });
    renderIt();

    await waitFor(() => expect(value()).toHaveTextContent("1"));
    typeKeys(value(), "2");
    leave(value());

    expect(await screen.findByText(/Not saved: repository is read-only/)).toBeInTheDocument();
  });

  it("creates the global policy's schedule when there is none yet", async () => {
    axios.get.mockRejectedValue({ response: { status: 404 } });
    axios.put.mockResolvedValue({ data: {} });
    renderIt();

    await waitFor(() => expect(value()).toHaveTextContent("—"));
    typeKeys(value(), "1");
    press(unit(), "h");
    leave(unit());

    await waitFor(() => expect(axios.put).toHaveBeenCalledWith(POLICY, { scheduling: { intervalSeconds: 3600 } }));
  });

  it("notes sources that have a schedule of their own", async () => {
    mockPolicy();
    renderIt({ sources: [{ schedule: { intervalSeconds: 3600 } }, { schedule: { intervalSeconds: 21600 } }] });

    expect(await screen.findByText(/some sources have their own schedule/)).toBeInTheDocument();
    cleanup();

    renderIt({ sources: [{ schedule: { intervalSeconds: 3600 } }] });
    await waitFor(() => expect(value()).toHaveTextContent("1"));
    expect(screen.queryByText(/own schedule/)).not.toBeInTheDocument();
  });
});
