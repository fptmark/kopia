import React, { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { DataTable } from "../../../src/next/ui";

const rows = Array.from({ length: 23 }, (_, i) => ({ id: "r" + i, name: "item" + String(i).padStart(2, "0"), n: i }));
const columns = [
  { id: "name", header: "Name", accessor: (r) => r.name },
  { id: "n", header: "Number", align: "end", accessor: (r) => r.n, cell: (r, v) => <b>#{v}</b> },
  { id: "plain", header: "No sort", cell: () => "x" },
];

const names = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelectorAll("td")[0]?.textContent);

describe("DataTable", () => {
  it("shows one page of rows and the range", () => {
    render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    expect(names()).toHaveLength(10);
    expect(screen.getByTestId("range")).toHaveTextContent("1–10 of 23");
  });

  it("pages forward and back, and changes the page size", () => {
    render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    fireEvent.click(screen.getByLabelText("Next page"));
    expect(names()[0]).toBe("item10");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Last page"));
    expect(names()).toHaveLength(3);
    expect(screen.getByLabelText("Next page")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("First page"));
    expect(names()[0]).toBe("item00");

    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "25" } });
    expect(names()).toHaveLength(23);
    expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument();
  });

  it("sorts by clicking a header, ascending then descending, and not on columns without a value", () => {
    render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    fireEvent.click(screen.getByText("Number"));
    expect(names()[0]).toBe("item00");
    fireEvent.click(screen.getByText("Number"));
    expect(names()[0]).toBe("item22");
    expect(screen.getByText("Number").closest("th")).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(screen.getByText("No sort"));
    expect(names()[0]).toBe("item22");
    expect(screen.getByText("No sort").closest("th")).not.toHaveAttribute("aria-sort");
  });

  it("starts sorted when asked, and goes back to the first page when the sort changes", () => {
    render(
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        pageSize={10}
        initialSort={{ id: "n", desc: true }}
      />,
    );
    expect(names()[0]).toBe("item22");
    fireEvent.click(screen.getByLabelText("Next page"));
    fireEvent.click(screen.getByText("Name"));
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("shows the empty text and no footer without data", () => {
    render(<DataTable data={[]} columns={columns} emptyText="No rules." />);
    expect(screen.getByText("No rules.")).toBeInTheDocument();
    expect(screen.queryByTestId("range")).not.toBeInTheDocument();
  });

  it("stays on a valid page when the data shrinks", () => {
    const { rerender } = render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    fireEvent.click(screen.getByLabelText("Last page"));
    rerender(<DataTable data={rows.slice(0, 12)} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(names()).toHaveLength(2);
  });

  describe("selection", () => {
    function Harness({ initial = {} }) {
      const [selected, setSelected] = useState(initial);
      return (
        <>
          <span data-testid="count">{Object.keys(selected).length}</span>
          <DataTable
            data={rows}
            columns={columns}
            getRowId={(r) => r.id}
            pageSize={10}
            selection={{ selected, onChange: setSelected, isSelectable: (r) => r.n !== 3 }}
          />
        </>
      );
    }

    it("ticks and unticks the rows of the page from the header, skipping rows that cannot be selected", () => {
      render(<Harness />);
      const header = screen.getByLabelText("Select all on this page");
      fireEvent.click(header);
      expect(screen.getByTestId("count")).toHaveTextContent("9"); // 10 rows, one is not selectable
      expect(header).toBeChecked();

      fireEvent.click(screen.getByLabelText("Select all on this page"));
      expect(screen.getByTestId("count")).toHaveTextContent("0");
    });

    it("shows a partly ticked page as indeterminate", () => {
      render(<Harness initial={{ r0: true }} />);
      expect(screen.getByLabelText("Select all on this page").indeterminate).toBe(true);
    });

    it("toggles single rows, which have no checkbox when not selectable", () => {
      render(<Harness />);
      fireEvent.click(screen.getByLabelText("Select row r1"));
      expect(screen.getByTestId("count")).toHaveTextContent("1");
      fireEvent.click(screen.getByLabelText("Select row r1"));
      expect(screen.getByTestId("count")).toHaveTextContent("0");
      expect(screen.queryByLabelText("Select row r3")).not.toBeInTheDocument();
    });

    it("keeps the ticks of rows on other pages", () => {
      render(<Harness initial={{ r15: true }} />);
      fireEvent.click(screen.getByLabelText("Select all on this page"));
      expect(screen.getByTestId("count")).toHaveTextContent("10");
      fireEvent.click(screen.getByLabelText("Select all on this page"));
      expect(screen.getByTestId("count")).toHaveTextContent("1");
    });
  });
});
