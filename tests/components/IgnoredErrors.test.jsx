import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import { vi } from "vitest";
import { IgnoredErrors } from "../../src/components/IgnoredErrors";

vi.mock("axios");

const rules = [
  {
    id: "a",
    source: "/Users/me",
    path: "Library/Accounts",
    scope: "folder",
    kind: "permission",
    hides: 12,
    expired: false,
  },
  {
    id: "b",
    source: "",
    path: "",
    scope: "folder",
    kind: "missing",
    hides: 0,
    expired: true,
    expires: "2026-01-02T00:00:00Z",
  },
  {
    id: "c",
    source: "/Users/me",
    path: "x/y.db",
    scope: "file",
    hides: 1,
    expired: false,
    expires: "2099-01-02T00:00:00Z",
  },
];

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("IgnoredErrors", () => {
  it("lists the rules with what they hide now", async () => {
    axios.get.mockResolvedValue({ data: { rules } });
    render(<IgnoredErrors />);

    const rows = await screen.findAllByTestId("ignored-error-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Library/Accounts");
    expect(rows[0]).toHaveTextContent("permission denied in this folder");
    expect(rows[0]).toHaveTextContent("12");
    expect(rows[0]).toHaveTextContent("Never");
    expect(rows[1]).toHaveTextContent("Any source");
    expect(rows[1]).toHaveTextContent("(whole source)");
    expect(rows[1]).toHaveTextContent("Expired");
    expect(rows[2]).toHaveTextContent("any error on this file");
  });

  it("says when nothing is ignored", async () => {
    axios.get.mockResolvedValue({ data: { rules: [] } });
    render(<IgnoredErrors />);

    expect(await screen.findByText("No errors are ignored.")).toBeInTheDocument();
  });

  it("removes a rule and reloads", async () => {
    axios.get.mockResolvedValueOnce({ data: { rules } }).mockResolvedValueOnce({ data: { rules: rules.slice(1) } });
    axios.delete.mockResolvedValue({ data: {} });
    render(<IgnoredErrors />);

    fireEvent.click(await screen.findByLabelText("Remove the rule for Library/Accounts"));

    await waitFor(() => expect(screen.getAllByTestId("ignored-error-row")).toHaveLength(2));
    expect(axios.delete).toHaveBeenCalledWith("/api/v1/ignored-errors/a");
  });

  it("reports a rule that could not be removed", async () => {
    axios.get.mockResolvedValue({ data: { rules } });
    axios.delete.mockRejectedValue({ response: { data: { message: "rule not found" } } });
    render(<IgnoredErrors />);

    fireEvent.click(await screen.findByLabelText("Remove the rule for Library/Accounts"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not removed: rule not found");
  });
});
