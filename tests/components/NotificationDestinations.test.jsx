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
  failures: ["health", "failed", "skipped", "maint", "watchdog"],
  success: { freq: "off", time: "08:00" },
};
const mac = {
  id: "mac",
  type: "mac",
  name: "This Mac",
  failures: ["health", "failed"],
  success: { freq: "daily", time: "08:00" },
};

function mockApi({ destinations = [iphone, mac], preview = { immediate: [], summary: null }, log = [] } = {}) {
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
  it("shows one row per destination with its failures and success settings", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByLabelText("Name of iPhone")).toHaveValue("iPhone");
    expect(screen.getByLabelText("Send to for iPhone")).toHaveValue("+1 555 0100");
    expect(screen.queryByLabelText("Send to for This Mac")).not.toBeInTheDocument(); // nothing to address
    expect(screen.getByLabelText("Failures for iPhone")).toHaveTextContent("All failures");
    expect(screen.getByLabelText("Failures for This Mac")).toHaveTextContent("2 of 4 failures");
    expect(screen.getByLabelText("Success messages for iPhone")).toHaveValue("off");
    expect(screen.getByLabelText("Success messages for This Mac")).toHaveValue("daily");
  });

  it("has no frequency choice for failures: they are always immediate", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByText(/always immediate/)).toBeInTheDocument();
    expect(screen.queryByText(/Roll-up/)).not.toBeInTheDocument();
  });

  it("chooses failure types with check boxes and saves each change", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.click(await screen.findByLabelText("Failures for This Mac"));
    fireEvent.click(await screen.findByLabelText("Snapshot finished with skipped files"));

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(lastPut()[1].failures).toEqual(["health", "failed", "skipped"]);

    fireEvent.click(screen.getByLabelText("Snapshot failed"));
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].failures).toEqual(["health", "skipped"]);
    expect(screen.getByLabelText("Failures for This Mac")).toHaveTextContent("2 of 4 failures");
  });

  it("selects all or none, and keeps a failure type this page does not list", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.click(await screen.findByLabelText("Failures for iPhone"));
    fireEvent.click(screen.getAllByText("None")[0]);
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[0].failures).toEqual(["watchdog"]);
    expect(screen.getByLabelText("Failures for iPhone")).toHaveTextContent("None");

    fireEvent.click(screen.getAllByText("All")[0]);
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[0].failures).toEqual(["health", "failed", "skipped", "maint", "watchdog"]);
  });

  it("saves a changed success choice and keeps everything else about the destinations", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.change(await screen.findByLabelText("Success messages for iPhone"), { target: { value: "weekly" } });

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(lastPut()[0].success).toMatchObject({ freq: "weekly", time: "08:00" });
    expect(lastPut()[0].target).toBe("+1 555 0100");
    expect(lastPut()[1]).toEqual(mac);
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

    fireEvent.change(await screen.findByLabelText("Success messages for iPhone"), { target: { value: "now" } });
    expect(await screen.findByText(/Not saved: destination "x" needs a phone number/)).toBeInTheDocument();
  });

  it("shows the time only for summaries, and edits it as hour, minute and AM/PM", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByLabelText("Hour for This Mac")).toBeInTheDocument();
    expect(screen.queryByLabelText("Hour for iPhone")).not.toBeInTheDocument(); // success is off
    expect(screen.getByTestId("next-mac")).toHaveTextContent("Next:");

    fireEvent.change(screen.getByLabelText("Hour for This Mac"), { target: { value: "7" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].success.time).toBe("07:00");

    fireEvent.change(screen.getByLabelText("AM or PM for This Mac"), { target: { value: "PM" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].success.time).toBe("19:00");

    fireEvent.change(screen.getByLabelText("Minute for This Mac"), { target: { value: "35" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(3));
    expect(lastPut()[1].success.time).toBe("19:35");
  });

  it("shows the day picker that matches the frequency, and none for immediate or off", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const choice = await screen.findByLabelText("Success messages for This Mac");
    expect(screen.queryByLabelText("Day of week for This Mac")).not.toBeInTheDocument();

    fireEvent.change(choice, { target: { value: "weekly" } });
    expect(await screen.findByLabelText("Day of week for This Mac")).toBeInTheDocument();

    fireEvent.change(choice, { target: { value: "monthly" } });
    expect(await screen.findByLabelText("Day of month for This Mac")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Day of month for This Mac")).getByText("Last day")).toBeInTheDocument();

    fireEvent.change(choice, { target: { value: "now" } });
    await waitFor(() => expect(screen.queryByLabelText("Hour for This Mac")).not.toBeInTheDocument());
  });

  it("adds a destination of the chosen type: every failure, no success messages", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.click(await screen.findByText("+ Add destination"));
    await waitFor(() => expect(axios.put).toHaveBeenCalled());

    const list = lastPut();
    expect(list).toHaveLength(3);
    expect(list[2]).toMatchObject({
      type: "imessage",
      name: "iMessage",
      failures: ["health", "failed", "skipped", "maint", "watchdog"],
      success: { freq: "off" },
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

  it("previews the immediate messages and the summary of the chosen destination", async () => {
    mockApi({
      preview: {
        immediate: [{ title: "Snapshot failed", body: "/Users/me could not be backed up." }],
        summary: { title: "Backup summary, last 24 hours", body: "Failed snapshots: 0" },
      },
    });
    render(<NotificationDestinations />);

    const msgs = await screen.findAllByTestId("preview-message");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toHaveTextContent("/Users/me could not be backed up.");
    expect(msgs[1]).toHaveTextContent("Backup summary, last 24 hours");
    expect(axios.get).toHaveBeenCalledWith("/api/v1/notifications/preview?destination=iphone");

    fireEvent.click(screen.getByRole("button", { name: "This Mac" }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith("/api/v1/notifications/preview?destination=mac"));
  });

  it("says when nothing is sent immediately or as a summary", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByText("Nothing is sent immediately.")).toBeInTheDocument();
    expect(screen.getByText("No summary is sent.")).toBeInTheDocument();
  });

  it("lists recent messages with their destination, message and result", async () => {
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
          event: "summary",
          mode: "summary",
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
    expect(rows[2]).toHaveTextContent("Summary");
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
