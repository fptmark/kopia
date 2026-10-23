import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { ignoreChoices } from "../../src/components/FailureActions";
import { FailuresModalHost, showFailures } from "../../src/utils/uiutil";

vi.mock("axios");

const op = (path, extra = {}) => ({ path, error: "open /x: operation not permitted", kind: "permission", ...extra });

const open = (extra = {}) =>
  act(() =>
    showFailures({
      numFailed: 3,
      errors: [op("Library/Accounts/a"), op("Library/Accounts/b"), op("Library/Mail/c")],
      source: "/Users/me",
      userName: "me",
      host: "mac",
      taskId: "7",
      ...extra,
    }),
  );

function renderHost() {
  return render(
    <MemoryRouter>
      <FailuresModalHost />
    </MemoryRouter>,
  );
}

afterEach(() => {
  act(() => showFailures(null));
  cleanup();
  vi.resetAllMocks();
});

describe("ignoreChoices", () => {
  it("offers the kind of error under a folder first, then any error", () => {
    expect(ignoreChoices({ path: "Library/a", kind: "permission", file: false }).map((c) => c.rule)).toEqual([
      { path: "Library/a", scope: "folder", kind: "permission" },
      { path: "Library/a", scope: "folder" },
    ]);
  });

  it("offers a file by itself first", () => {
    expect(ignoreChoices({ path: "a/b", kind: "permission", file: true }).map((c) => c.rule)).toEqual([
      { path: "a/b", scope: "file" },
      { path: "a/b", scope: "folder" },
    ]);
  });
});

describe("failed files dialog actions", () => {
  it("has no actions without a source (a snapshot listing)", () => {
    renderHost();
    open({ source: undefined });

    expect(screen.queryByText("Ignore")).toBeNull();
    expect(screen.queryByText("Exclude")).toBeNull();
  });

  it("ignores a group of errors, then reloads the list without them", async () => {
    axios.post.mockResolvedValue({ data: { id: "r1" } });
    axios.get.mockResolvedValue({
      data: {
        errors: [
          op("Library/Accounts/a", { ignored: true }),
          op("Library/Accounts/b", { ignored: true }),
          op("Library/Mail/c"),
        ],
      },
    });
    renderHost();
    open();

    const groups = screen.getAllByTestId("failure-group");
    expect(groups[0]).toHaveTextContent("Library/Accounts");
    fireEvent.click(groups[0].querySelectorAll("button")[1]); // Ignore on the group

    expect(screen.getByTestId("ignore-dialog")).toHaveTextContent("permission denied in this folder");
    fireEvent.click(screen.getByTestId("ignore-confirm"));

    await waitFor(() => expect(screen.getByTestId("ignored-count")).toHaveTextContent("2 more errors are ignored"));
    expect(axios.post).toHaveBeenCalledWith("/api/v1/ignored-errors", {
      path: "Library/Accounts",
      scope: "folder",
      kind: "permission",
      source: "/Users/me",
      expiresDays: 0,
    });
    expect(axios.get).toHaveBeenCalledWith("/api/v1/tasks/7/errors");
    expect(screen.getByText(/1 error while snapshotting/)).toBeInTheDocument();
    expect(screen.queryByText("Library/Accounts")).toBeNull();
  });

  it("treats a lone error as a file", () => {
    renderHost();
    open();

    fireEvent.click(screen.getAllByTestId("failure-group")[1].querySelectorAll("button")[1]); // Library/Mail/c

    expect(screen.getByLabelText("Only this file")).toBeChecked();
  });

  it("ignores for a limited time when asked", async () => {
    axios.post.mockResolvedValue({ data: {} });
    axios.get.mockResolvedValue({ data: { errors: [] } });
    renderHost();
    open();

    fireEvent.click(screen.getAllByTestId("failure-group")[0].querySelectorAll("button")[1]);
    fireEvent.click(screen.getByLabelText("Any error in this folder"));
    fireEvent.change(screen.getByLabelText("Ignore for"), { target: { value: "30" } });
    fireEvent.click(screen.getByTestId("ignore-confirm"));

    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(axios.post.mock.calls[0][1]).toMatchObject({ scope: "folder", expiresDays: 30 });
    expect(axios.post.mock.calls[0][1].kind).toBeUndefined();
  });

  it("ignores one file from the expanded list", async () => {
    axios.post.mockResolvedValue({ data: {} });
    axios.get.mockResolvedValue({ data: { errors: [] } });
    renderHost();
    open();

    const group = screen.getAllByTestId("failure-group")[0];
    fireEvent.click(group.querySelector("button")); // expand
    fireEvent.click(group.querySelectorAll("li")[0].querySelectorAll("button")[0]);
    fireEvent.click(screen.getByTestId("ignore-confirm"));

    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(axios.post.mock.calls[0][1]).toMatchObject({ path: "Library/Accounts/a", scope: "file" });
  });

  it("shows why an ignore could not be saved and keeps the dialog", async () => {
    axios.post.mockRejectedValue({ response: { data: { message: "a file rule needs a path" } } });
    renderHost();
    open();

    fireEvent.click(screen.getAllByTestId("failure-group")[0].querySelectorAll("button")[1]);
    fireEvent.click(screen.getByTestId("ignore-confirm"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved: a file rule needs a path");
    expect(screen.getByTestId("ignore-dialog")).toBeInTheDocument();
  });

  it("excludes a folder from backup after confirming, by editing the policy of the source", async () => {
    axios.get.mockResolvedValue({ data: { files: { ignore: ["/old"] } } });
    axios.put.mockResolvedValue({ data: {} });
    renderHost();
    open();

    fireEvent.click(screen.getAllByTestId("failure-group")[0].querySelectorAll("button")[2]); // Exclude

    expect(screen.getByTestId("exclude-dialog")).toHaveTextContent("/Library/Accounts");
    expect(screen.getByTestId("exclude-dialog")).toHaveTextContent("stay until those snapshots are removed");
    expect(axios.put).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("exclude-confirm"));

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(axios.put).toHaveBeenCalledWith("/api/v1/policy?userName=me&host=mac&path=%2FUsers%2Fme", {
      files: { ignore: ["/old", "/Library/Accounts"] },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("The next snapshot skips it");
  });

  it("leaves the policy alone when excluding is cancelled", () => {
    renderHost();
    open();

    fireEvent.click(screen.getAllByTestId("failure-group")[0].querySelectorAll("button")[2]);
    fireEvent.click(screen.getByText("Cancel"));

    expect(axios.put).not.toHaveBeenCalled();
    expect(screen.queryByTestId("exclude-dialog")).toBeNull();
  });
});
