import { cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import { vi } from "vitest";
import { NotificationDestinations } from "../../src/components/NotificationDestinations";

vi.mock("axios");

const iphone = {
  id: "iphone",
  type: "imessage",
  name: "iPhone",
  target: "+1 555 0100",
  events: { health: "now", failed: "now", skipped: "now", maint: "now", watchdog: "now" },
  rollup: { freq: "daily", weekday: 0, dom: 1, time: "08:00" },
};
const mac = {
  id: "mac",
  type: "mac",
  name: "This Mac",
  events: { health: "now", failed: "now", maint: "now" },
};

function mockApi({ destinations = [iphone, mac], preview = { immediate: [] }, log = [] } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.startsWith("/api/v1/notifications/destinations")) return Promise.resolve({ data: { destinations } });
    if (url.startsWith("/api/v1/notifications/preview")) return Promise.resolve({ data: preview });
    if (url.startsWith("/api/v1/notifications/log")) return Promise.resolve({ data: log });
    return Promise.reject(new Error("unexpected " + url));
  });
  axios.put.mockResolvedValue({ data: {} });
  axios.post.mockResolvedValue({ data: {} });
}

const lastPut = () => axios.put.mock.calls.at(-1)[1].destinations;

afterEach(() => {
  // unmount first: a component still mounted would call the mocks after they are reset
  cleanup();
  vi.resetAllMocks();
});

describe("NotificationDestinations", () => {
  it("shows events as rows and destinations as columns, each cell with its mode", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const failed = await screen.findByLabelText("Snapshot failed for iPhone");
    expect(failed).toHaveValue("now");
    expect(screen.getByLabelText("Snapshot finished with skipped files for This Mac")).toHaveValue("off");
    expect(screen.getByLabelText("Snapshot finished with skipped files for iPhone")).toHaveValue("now");
  });

  it("offers no roll-up for the health alert", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const health = await screen.findByLabelText("Backup problem found or recovered for iPhone");
    expect(
      within(health)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Off", "Immediately"]);
    const failed = screen.getByLabelText("Snapshot failed for iPhone");
    expect(
      within(failed)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Off", "Immediately", "Roll-up"]);
  });

  it("saves a changed cell at once, keeping everything else about the destinations", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.change(await screen.findByLabelText("Snapshot failed for This Mac"), { target: { value: "off" } });

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    const [, mac2] = lastPut();
    expect(mac2.events.failed).toBe("off");
    expect(mac2.events.health).toBe("now");
    // an event this page does not show is carried through untouched
    expect(lastPut()[0].events.watchdog).toBe("now");
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("saves a typed name or number when the field is left, not on every keystroke", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const to = await screen.findByLabelText("Send to for iPhone");
    fireEvent.change(to, { target: { value: "+1 555 0199" } });
    fireEvent.change(to, { target: { value: "+1 555 0199 " } });
    expect(axios.put).not.toHaveBeenCalled();

    fireEvent.blur(to);
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[0].target).toBe("+1 555 0199 ");
  });

  it("shows why a save was refused", async () => {
    mockApi();
    axios.put.mockRejectedValue({
      response: { data: { message: 'destination "x" needs a phone number or Apple ID' } },
    });
    render(<NotificationDestinations />);

    fireEvent.change(await screen.findByLabelText("Snapshot failed for iPhone"), { target: { value: "off" } });
    expect(await screen.findByText(/Not saved: destination "x" needs a phone number/)).toBeInTheDocument();
  });

  it("edits the roll-up time as hour, minute and AM/PM and stores 24-hour time", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.change(await screen.findByLabelText("Hour for iPhone"), { target: { value: "7" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[0].rollup.time).toBe("07:00");

    fireEvent.change(screen.getByLabelText("AM or PM for iPhone"), { target: { value: "PM" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[0].rollup.time).toBe("19:00");

    fireEvent.change(screen.getByLabelText("Minute for iPhone"), { target: { value: "35" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(3));
    expect(lastPut()[0].rollup.time).toBe("19:35");
  });

  it("shows the day picker that matches the frequency", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByLabelText("Hour for iPhone")).toBeInTheDocument();
    expect(screen.queryByLabelText("Day of week for iPhone")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("How often for iPhone"), { target: { value: "weekly" } });
    expect(await screen.findByLabelText("Day of week for iPhone")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("How often for iPhone"), { target: { value: "monthly" } });
    expect(await screen.findByLabelText("Day of month for iPhone")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Day of month for iPhone")).getByText("Last day")).toBeInTheDocument();
  });

  it("says when nothing is set to roll-up, and shows the next time when something is", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByTestId("next-iphone")).toHaveTextContent("Nothing set to Roll-up");
    expect(screen.queryByTestId("rollup-notice")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Snapshot failed for iPhone"), { target: { value: "roll" } });
    expect(screen.getByTestId("next-iphone")).not.toHaveTextContent("Nothing set");
    expect(screen.getByTestId("rollup-notice")).toHaveTextContent(/not being sent yet/);
  });

  it("adds a destination of the chosen type with sensible defaults", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.click(await screen.findByText("+ Add destination"));
    await waitFor(() => expect(axios.put).toHaveBeenCalled());

    const list = lastPut();
    expect(list).toHaveLength(3);
    expect(list[2]).toMatchObject({
      type: "imessage",
      name: "iMessage",
      events: { health: "now", failed: "now", skipped: "off", maint: "now" },
    });
    expect(await screen.findByLabelText("Send to for iMessage")).toBeInTheDocument();
  });

  it("deletes a destination only after confirmation", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const del = await screen.findByLabelText("Delete This Mac");

    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    fireEvent.click(del);
    expect(axios.put).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    fireEvent.click(del);
    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(lastPut().map((d) => d.id)).toEqual(["iphone"]);
    expect(screen.queryByLabelText("Delete This Mac")).not.toBeInTheDocument();
  });

  it("sends a test message to one destination and reports the outcome", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.click(await screen.findByLabelText("Test iPhone"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/notifications/destinations/iphone/test", {}));
    expect(await screen.findByText("Test message sent to iPhone.")).toBeInTheDocument();

    axios.post.mockRejectedValue({ response: { data: { message: "Messages is not running" } } });
    fireEvent.click(screen.getByLabelText("Test This Mac"));
    expect(await screen.findByText(/Test to This Mac failed: Messages is not running/)).toBeInTheDocument();
  });

  it("previews the messages of the chosen destination", async () => {
    mockApi({ preview: { immediate: [{ title: "Snapshot failed", body: "/Users/me could not be backed up." }] } });
    render(<NotificationDestinations />);

    const msg = await screen.findByTestId("preview-message");
    expect(msg).toHaveTextContent("Snapshot failed");
    expect(msg).toHaveTextContent("/Users/me could not be backed up.");
    expect(axios.get).toHaveBeenCalledWith("/api/v1/notifications/preview?destination=iphone");

    fireEvent.click(screen.getByRole("button", { name: "This Mac" }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith("/api/v1/notifications/preview?destination=mac"));
  });

  it("lists recent messages with their destination, event and result", async () => {
    mockApi({
      log: [
        {
          sentAt: "2026-10-22T10:00:00Z",
          destination: "iphone",
          event: "failed",
          mode: "now",
          status: "sent",
          attempts: 1,
        },
        {
          sentAt: "2026-10-22T09:00:00Z",
          destination: "gone",
          event: "maint",
          mode: "now",
          status: "failed",
          attempts: 4,
          error: "Messages is not running",
        },
      ],
    });
    render(<NotificationDestinations />);

    const rows = within(await screen.findByTestId("recent-messages")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("iPhone");
    expect(rows[1]).toHaveTextContent("Snapshot failed");
    expect(rows[1]).toHaveTextContent("Sent");
    expect(rows[2]).toHaveTextContent("gone"); // a deleted destination still shows by its id
    expect(rows[2]).toHaveTextContent("Failed");
    expect(rows[2]).toHaveTextContent("Messages is not running");
    expect(rows[2]).toHaveTextContent("4 tries");
  });

  it("explains an empty setup and a failed load", async () => {
    mockApi({ destinations: [] });
    const { unmount } = render(<NotificationDestinations />);
    expect(await screen.findByText(/No destinations. Nothing is sent/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been sent yet/)).toBeInTheDocument();
    unmount();

    axios.get.mockRejectedValue({ response: { data: { message: "notifications are not set up" } } });
    render(<NotificationDestinations />);
    expect(await screen.findByText(/notifications are not set up/)).toBeInTheDocument();
  });
});
