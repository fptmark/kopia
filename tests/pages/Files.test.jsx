import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { Files } from "../../src/pages/Files";

vi.mock("../../src/pages/SnapshotSearch", () => ({ SnapshotSearch: () => <div>search page</div> }));
vi.mock("../../src/components/ExcludedFiles", () => ({ ExcludedFiles: () => <div>excluded page</div> }));

afterEach(cleanup);

describe("Files", () => {
  it("opens on List/Restore and has an Excluded tab", () => {
    render(<Files />);

    expect(screen.getByRole("tab", { name: "List/Restore" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("search page")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Excluded" }));
    expect(screen.getByText("excluded page")).toBeVisible();
  });
});
