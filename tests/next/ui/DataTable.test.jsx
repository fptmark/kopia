import React, { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router";
import { describe, it, expect, vi } from "vitest";
import { DataTable, Page, Toolbar } from "../../../src/next/ui";

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

  it("puts a pager above the grid as well as below it", () => {
    const { container } = render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    const top = container.querySelector(".nx-table-top");
    expect(top).toBeInTheDocument();
    fireEvent.click(within(top).getByLabelText("Next page"));
    expect(screen.getByTestId("range")).toHaveTextContent("11–20 of 23");
  });

  it("puts the pager at the end of the page's toolbar when there is one, so it takes no line of its own", () => {
    const { container } = render(
      <MemoryRouter>
        <Page title="T">
          <Toolbar>
            <Toolbar.Group label="Show">x</Toolbar.Group>
          </Toolbar>
          <DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />
        </Page>
      </MemoryRouter>,
    );
    const slot = container.querySelector(".nx-toolbar .nx-pager-slot");
    expect(slot).toBeInTheDocument();
    expect(container.querySelector(".nx-table-top")).not.toBeInTheDocument();
    fireEvent.click(within(slot).getByLabelText("Next page"));
    expect(screen.getByTestId("range")).toHaveTextContent("11–20 of 23");
  });

  it("measures the column widths once and keeps them while paging", () => {
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 10,
      top: 0,
      left: 0,
      right: 120,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    try {
      const { container } = render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
      const widths = () => [...container.querySelectorAll("col")].map((c) => c.style.width);
      expect(widths()).toEqual(["120px", "120px", "120px"]);
      expect(container.querySelector("table")).toHaveClass("fixed");
      spy.mockReturnValue({
        width: 300,
        height: 10,
        top: 0,
        left: 0,
        right: 300,
        bottom: 10,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      fireEvent.click(screen.getAllByLabelText("Next page")[0]);
      expect(widths()).toEqual(["120px", "120px", "120px"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("pages forward and back, and changes the page size", () => {
    render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    fireEvent.click(screen.getAllByLabelText("Next page")[0]);
    expect(names()[0]).toBe("item10");
    expect(screen.getAllByText("Page 2 of 3")[0]).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText("Last page")[0]);
    expect(names()).toHaveLength(3);
    expect(screen.getAllByLabelText("Next page")[0]).toBeDisabled();
    fireEvent.click(screen.getAllByLabelText("First page")[0]);
    expect(names()[0]).toBe("item00");

    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "25" } });
    expect(names()).toHaveLength(23);
    expect(screen.queryAllByLabelText("Next page")).toHaveLength(0);
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

  it("puts rows without a value last, whichever way it sorts", () => {
    const data = [
      { id: "a", name: "a", n: 5 },
      { id: "b", name: "b", n: undefined },
      { id: "c", name: "c", n: 1 },
      { id: "d", name: "d", n: undefined },
      { id: "e", name: "e", n: 9 },
    ];
    render(<DataTable data={data} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    fireEvent.click(screen.getByText("Number"));
    expect(names().slice(0, 3)).toEqual(["c", "a", "e"]);
    expect(names().slice(3).sort()).toEqual(["b", "d"]);
    fireEvent.click(screen.getByText("Number"));
    expect(names().slice(0, 3)).toEqual(["e", "a", "c"]);
    expect(names().slice(3).sort()).toEqual(["b", "d"]);
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
    fireEvent.click(screen.getAllByLabelText("Next page")[0]);
    fireEvent.click(screen.getByText("Name"));
    expect(screen.getAllByText("Page 1 of 3")[0]).toBeInTheDocument();
  });

  it("shows the empty text and no footer without data", () => {
    render(<DataTable data={[]} columns={columns} emptyText="No rules." />);
    expect(screen.getByText("No rules.")).toBeInTheDocument();
    expect(screen.queryByTestId("range")).not.toBeInTheDocument();
  });

  it("stays on a valid page when the data shrinks", () => {
    const { rerender } = render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    fireEvent.click(screen.getAllByLabelText("Last page")[0]);
    rerender(<DataTable data={rows.slice(0, 12)} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    expect(screen.getAllByText("Page 2 of 2")[0]).toBeInTheDocument();
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
