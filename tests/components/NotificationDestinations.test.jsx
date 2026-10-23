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

function mockApi({ destinations = [iphone, mac], accounts = [], log = [], repeatSeconds = 43200 } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.startsWith("/api/v1/notifications/destinations"))
      return Promise.resolve({ data: { repeatSeconds, destinations } });
    if (url === "/api/v1/notifications/email-accounts") return Promise.resolve({ data: { accounts } });
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

  it("labels failures as immediate and explains repeats in one short line", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByText("Failures (immediate)")).toBeInTheDocument();
    expect(screen.getByText(/Repeated failures are sent once every/)).toHaveTextContent("per destination");
    expect(screen.queryByText(/Roll-up/)).not.toBeInTheDocument();
    expect(screen.queryByText(/would receive/)).not.toBeInTheDocument();
    expect(axios.get).not.toHaveBeenCalledWith(expect.stringContaining("/preview"));
  });

  it("lets the user enter the repeat period with a unit, saved with the destinations when the field is left", async () => {
    mockApi({ repeatSeconds: 6 * 3600 });
    render(<NotificationDestinations />);

    const period = await screen.findByLabelText("Repeat period");
    expect(period).toHaveValue("6");
    expect(screen.getByLabelText("Repeat period unit")).toHaveValue("hr");

    fireEvent.change(period, { target: { value: "24" } });
    expect(axios.put).not.toHaveBeenCalled(); // not on every keystroke
    fireEvent.blur(period);

    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put.mock.calls[0][1].repeatSeconds).toBe(24 * 3600);
    expect(axios.put.mock.calls[0][1].destinations).toHaveLength(2);

    // 24 hours is shown as the whole day it is
    expect(period).toHaveValue("1");
    expect(screen.getByLabelText("Repeat period unit")).toHaveValue("days");

    // later changes to a destination keep sending the new period
    fireEvent.change(screen.getByLabelText("Success messages for iPhone"), { target: { value: "now" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(axios.put.mock.calls[1][1].repeatSeconds).toBe(24 * 3600);
  });

  it("allows a short repeat period in minutes", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const period = await screen.findByLabelText("Repeat period");
    fireEvent.change(screen.getByLabelText("Repeat period unit"), { target: { value: "min" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(axios.put.mock.calls[0][1].repeatSeconds).toBe(12 * 60);
    expect(period).toHaveValue("12");
  });

  it("refuses a repeat period under a minute or over 30 days and keeps the saved one", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const period = await screen.findByLabelText("Repeat period");

    const leave = (text, unit) => {
      fireEvent.change(period, { target: { value: text } });
      if (unit) {
        fireEvent.change(screen.getByLabelText("Repeat period unit"), { target: { value: unit } });
      } else {
        fireEvent.blur(period);
      }
    };

    for (const [text, unit] of [["0"], ["abc"], ["30", "sec"], ["31", "days"]]) {
      leave(text, unit);
      expect(await screen.findByText(/from 1 min to 30 days/)).toBeInTheDocument();
      expect(period).toHaveValue("12");
      expect(screen.getByLabelText("Repeat period unit")).toHaveValue("hr");
    }

    expect(axios.put).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repeatSeconds: 30 }));
  });

  it("names a destination once: the name is not repeated as a type label", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByLabelText("Name of This Mac")).toHaveValue("This Mac");
    expect(screen.queryAllByText("This Mac")).toHaveLength(0); // no second, separate label
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

  it("shows the time only for summaries, as one field, and saves 24-hour time", async () => {
    mockApi();
    render(<NotificationDestinations />);

    expect(await screen.findByLabelText("Hour for This Mac")).toHaveTextContent("8");
    expect(screen.queryByLabelText("Hour for iPhone")).not.toBeInTheDocument(); // success is off
    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("Hour for This Mac"), { key: "7" });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].success.time).toBe("07:00");

    fireEvent.keyDown(screen.getByLabelText("AM or PM for This Mac"), { key: "p" });
    await waitFor(() => expect(axios.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].success.time).toBe("19:00");
  });

  it("shows the day part that matches the frequency, and none for immediate or off", async () => {
    mockApi();
    render(<NotificationDestinations />);

    const choice = await screen.findByLabelText("Success messages for This Mac");
    expect(screen.queryByLabelText("Day of week for This Mac")).not.toBeInTheDocument();

    fireEvent.change(choice, { target: { value: "weekly" } });
    expect(await screen.findByLabelText("Day of week for This Mac")).toHaveTextContent("Mon");

    fireEvent.keyDown(screen.getByLabelText("Day of week for This Mac"), { key: "f" });
    await waitFor(() => expect(lastPut()[1].success).toMatchObject({ freq: "weekly", weekday: 4 }));

    fireEvent.change(choice, { target: { value: "monthly" } });
    expect(await screen.findByLabelText("Day of month for This Mac")).toHaveTextContent("1st");

    fireEvent.change(choice, { target: { value: "now" } });
    await waitFor(() => expect(screen.queryByLabelText("Hour for This Mac")).not.toBeInTheDocument());
  });

  it("offers three kinds of destination to add: This Mac, iPhone and Email", async () => {
    mockApi({ destinations: [] });
    render(<NotificationDestinations />);

    fireEvent.click(await screen.findByText("+ Add destination"));
    const items = screen.getAllByRole("button").filter((b) => ["This Mac", "iPhone", "Email"].includes(b.textContent));
    expect(items.map((b) => b.textContent)).toEqual(["This Mac", "iPhone", "Email"]);
  });

  it("adds a destination with every failure and no success messages", async () => {
    mockApi();
    render(<NotificationDestinations />);

    fireEvent.click(await screen.findByText("+ Add destination"));
    fireEvent.click(screen.getByText("iPhone", { selector: ".dropdown-item" }));
    await waitFor(() => expect(axios.put).toHaveBeenCalled());

    const list = lastPut();
    expect(list).toHaveLength(3);
    expect(list[2]).toMatchObject({
      type: "imessage",
      name: "iPhone",
      failures: ["health", "failed", "skipped", "maint", "watchdog"],
      success: { freq: "off" },
    });
    expect((await screen.findAllByLabelText("Send to for iPhone")).length).toBeGreaterThan(0);
  });

  it("asks which Mail account sends only when Mail has more than one", async () => {
    const email = {
      id: "e",
      type: "email",
      name: "Email",
      target: "me@gmail.com",
      failures: [],
      success: { freq: "off" },
    };

    mockApi({ destinations: [email], accounts: [{ name: "Gmail", addresses: ["me@gmail.com"] }] });
    const { unmount } = render(<NotificationDestinations />);
    expect(await screen.findByLabelText("Send to for Email")).toHaveValue("me@gmail.com");
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith("/api/v1/notifications/email-accounts"));
    expect(screen.queryByLabelText("Send from for Email")).not.toBeInTheDocument();
    unmount();
    cleanup();

    mockApi({
      destinations: [email],
      accounts: [
        { name: "Gmail", addresses: ["me@gmail.com"] },
        { name: "Work", addresses: ["me@work.example"] },
      ],
    });
    render(<NotificationDestinations />);

    const from = await screen.findByLabelText("Send from for Email");
    expect(from).toHaveValue("");
    fireEvent.change(from, { target: { value: "me@work.example" } });
    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(lastPut()[0]).toMatchObject({ target: "me@gmail.com", from: "me@work.example" });
  });

  it("does not ask Mail about accounts when there is no email destination", async () => {
    mockApi();
    render(<NotificationDestinations />);

    await screen.findByLabelText("Name of iPhone");
    expect(axios.get).not.toHaveBeenCalledWith("/api/v1/notifications/email-accounts");
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
