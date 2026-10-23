import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import { vi } from "vitest";
import { ExcludedFiles } from "../../src/components/ExcludedFiles";

vi.mock("axios");

const me = { userName: "me", host: "mac", path: "/Users/me" };
const global = { userName: "", host: "", path: "" };

const policies = [
  { target: me, policy: { files: { ignore: ["/Library/Caches", "*.tmp"] } } },
  { target: global, policy: { files: { ignore: [".DS_Store"] } } },
  { target: { userName: "me", host: "mac", path: "/Applications" }, policy: { retention: { keepLatest: 3 } } },
];

function mockGets(list = policies) {
  axios.get.mockImplementation((url) => {
    if (url === "/api/v1/policies") {
      return Promise.resolve({ data: { policies: list } });
    }
    if (url === "/api/v1/sources") {
      return Promise.resolve({ data: { sources: [{ source: me }, { source: { ...me, path: "/Applications" } }] } });
    }
    return Promise.resolve({ data: { files: { ignore: [".DS_Store"] } } });
  });
  axios.put.mockResolvedValue({ data: {} });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ExcludedFiles", () => {
  it("lists every pattern with what it applies to, everything first", async () => {
    mockGets();
    render(<ExcludedFiles />);

    const rows = await screen.findAllByTestId("excluded-row");
    expect(rows.map((r) => [...r.querySelectorAll("td")].slice(0, 2).map((c) => c.textContent))).toEqual([
      [".DS_Store", "Everything"],
      ["*.tmp", "/Users/me"],
      ["/Library/Caches", "/Users/me"],
    ]);
  });

  it("says when nothing is excluded", async () => {
    mockGets([]);
    render(<ExcludedFiles />);

    expect(await screen.findByText("Nothing is excluded.")).toBeInTheDocument();
  });

  it("removes a pattern from its own policy and reloads", async () => {
    mockGets();
    axios.get.mockImplementation((url) => {
      if (url === "/api/v1/policies") {
        return Promise.resolve({ data: { policies } });
      }
      if (url === "/api/v1/sources") {
        return Promise.resolve({ data: { sources: [] } });
      }
      return Promise.resolve({ data: { files: { ignore: ["/Library/Caches", "*.tmp"] } } });
    });
    render(<ExcludedFiles />);

    fireEvent.click(await screen.findByLabelText("Stop excluding *.tmp"));

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(axios.put).toHaveBeenCalledWith("/api/v1/policy?userName=me&host=mac&path=%2FUsers%2Fme", {
      files: { ignore: ["/Library/Caches"] },
    });
  });

  it("adds a pattern to the chosen policy", async () => {
    mockGets();
    render(<ExcludedFiles />);
    await screen.findAllByTestId("excluded-row");

    expect(screen.getByRole("button", { name: "Exclude" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: " /Movies " } });
    fireEvent.change(screen.getByLabelText("Applies to"), {
      target: { value: ["me", "mac", "/Users/me"].join("\u0000") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(axios.put).toHaveBeenCalledWith("/api/v1/policy?userName=me&host=mac&path=%2FUsers%2Fme", {
      files: { ignore: [".DS_Store", "/Movies"] },
    });
    await waitFor(() => expect(screen.getByLabelText("Pattern")).toHaveValue(""));
  });

  it("shows why a change failed", async () => {
    mockGets();
    axios.put.mockRejectedValue({ response: { data: { message: "invalid pattern" } } });
    render(<ExcludedFiles />);
    await screen.findAllByTestId("excluded-row");

    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not added: invalid pattern");
  });
});
