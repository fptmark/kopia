import React, { use, useMemo, useState } from "react";
import { getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { EmptyState } from "./Feedback";

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * The one table of the UI: sorting by clicking a header, paging, optional row selection with a header
 * checkbox for the current page, and an empty message.
 *
 * columns: [{ id, header, accessor?, cell?, sortable?, align?: "end", width?, sortFn? }]
 *   accessor(row) gives the value that is sorted and passed to cell(row, value); without it the column
 *   is not sortable. A row whose accessor gives undefined (a cell showing "—") sorts after the others
 *   in both directions. cell defaults to showing the value.
 * selection: { selected: {id: true}, onChange(selected), isSelectable?(row) }
 * initialSort: { id, desc }
 */
export function DataTable({
  data,
  columns,
  getRowId,
  selection,
  initialSort,
  pageSize: pageSizeProp,
  emptyText = "Nothing to show.",
  footer = true,
  label = "table",
  oneLine = false,
  head = true,
  ...rest
}) {
  const prefs = use(UIPreferencesContext);
  const preferred = pageSizeProp ?? prefs?.pageSize ?? 25;
  const sizes = PAGE_SIZES.includes(preferred) ? PAGE_SIZES : [...PAGE_SIZES, preferred].sort((a, b) => a - b);

  const [sorting, setSorting] = useState(initialSort ? [initialSort] : []);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(preferred);

  const defs = useMemo(
    () =>
      columns.map((c) => ({
        id: c.id,
        header: typeof c.header === "string" ? c.header : "",
        accessorFn: c.accessor ?? (() => null),
        enableSorting: c.sortable !== false && !!c.accessor,
        sortingFn: c.sortFn ?? "auto",
        sortDescFirst: false,
        sortUndefined: "last",
        meta: c,
      })),
    [columns],
  );

  const pageCount = Math.max(1, Math.ceil(data.length / pageSize));
  const index = Math.min(pageIndex, pageCount - 1);

  const table = useReactTable({
    data,
    columns: defs,
    getRowId: getRowId ? (row) => String(getRowId(row)) : undefined,
    state: { sorting, pagination: { pageIndex: index, pageSize } },
    onSortingChange: (updater) => {
      setSorting(updater);
      setPageIndex(0);
    },
    onPaginationChange: () => {},
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const rows = table.getRowModel().rows;
  const total = data.length;
  const first = total === 0 ? 0 : index * pageSize + 1;
  const last = Math.min(total, (index + 1) * pageSize);

  const selectable = (row) => !selection?.isSelectable || selection.isSelectable(row);
  const idOf = (row) => (getRowId ? String(getRowId(row)) : undefined);
  const pageRows = rows.map((r) => r.original).filter(selectable);
  const ticked = selection ? pageRows.filter((r) => selection.selected[idOf(r)]).length : 0;

  const togglePage = () => {
    const next = { ...selection.selected };
    for (const r of pageRows) {
      if (ticked < pageRows.length) {
        next[idOf(r)] = true;
      } else {
        delete next[idOf(r)];
      }
    }
    selection.onChange(next);
  };

  const toggleRow = (row) => {
    const next = { ...selection.selected };
    if (next[idOf(row)]) {
      delete next[idOf(row)];
    } else {
      next[idOf(row)] = true;
    }
    selection.onChange(next);
  };

  return (
    <div className="nx-table-wrap" {...rest}>
      <div className="nx-table-scroll">
        <table className={"table table-hover nx-table" + (oneLine ? " nx-one-line" : "")} aria-label={label}>
          <thead hidden={!head}>
            <tr>
              {selection && (
                <th className="check">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    aria-label="Select all on this page"
                    title="Select or clear every row on this page"
                    disabled={pageRows.length === 0}
                    checked={pageRows.length > 0 && ticked === pageRows.length}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate = ticked > 0 && ticked < pageRows.length;
                      }
                    }}
                    onChange={togglePage}
                  />
                </th>
              )}
              {table.getHeaderGroups()[0].headers.map((h) => {
                const c = h.column.columnDef.meta;
                const sorted = h.column.getIsSorted();
                const canSort = h.column.getCanSort();
                return (
                  <th
                    key={h.id}
                    className={(canSort ? "sortable " : "") + (c.align === "end" ? "end" : "")}
                    style={c.width ? { width: c.width } : undefined}
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                    onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                  >
                    {typeof c.header === "function" ? c.header() : c.header}
                    {canSort && (
                      <span className="nx-sort">{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isTicked = selection && selection.selected[idOf(row.original)];
              return (
                <tr key={row.id} className={isTicked ? "selected" : undefined}>
                  {selection && (
                    <td className="check">
                      {selectable(row.original) && (
                        <input
                          type="checkbox"
                          className="form-check-input"
                          aria-label={"Select row " + row.id}
                          checked={!!isTicked}
                          onChange={() => toggleRow(row.original)}
                        />
                      )}
                    </td>
                  )}
                  {row.getVisibleCells().map((cell) => {
                    const c = cell.column.columnDef.meta;
                    const value = cell.getValue();
                    return (
                      <td key={cell.id} className={c.align === "end" ? "end" : undefined}>
                        {c.cell ? c.cell(row.original, value) : (value ?? "")}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total === 0 && <EmptyState>{emptyText}</EmptyState>}
      {footer && total > 0 && (
        <div className="nx-table-foot">
          <span data-testid="range">
            {first}
            {"–"}
            {last} of {total.toLocaleString("en-US")}
          </span>
          <label className="d-flex align-items-center gap-2 mb-0">
            Rows per page
            <Form.Select
              size="sm"
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPageIndex(0);
              }}
            >
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Form.Select>
          </label>
          {pageCount > 1 && (
            <div className="pager">
              <Button
                size="sm"
                variant="secondary"
                aria-label="First page"
                disabled={index === 0}
                onClick={() => setPageIndex(0)}
              >
                {"«"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                aria-label="Previous page"
                disabled={index === 0}
                onClick={() => setPageIndex(index - 1)}
              >
                {"‹"}
              </Button>
              <span>
                Page {index + 1} of {pageCount.toLocaleString("en-US")}
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label="Next page"
                disabled={index >= pageCount - 1}
                onClick={() => setPageIndex(index + 1)}
              >
                {"›"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                aria-label="Last page"
                disabled={index >= pageCount - 1}
                onClick={() => setPageIndex(pageCount - 1)}
              >
                {"»"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
