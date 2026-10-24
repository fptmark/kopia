import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import { KIND_LABELS, listIgnoredErrors, removeIgnoredError } from "../../utils/ignoredErrors";
import { errorMessage } from "../api";
import { useLoad } from "../hooks";
import { CountText, DataTable, DateTimeText, Loaded, Notice, PathText, StatusBadge } from "../ui";

/** The errors that are not reported, one rule per row. Rules are added from the failed files of a snapshot. */
export function IgnoredErrors() {
  const state = useLoad(listIgnoredErrors, []);
  const [message, setMessage] = useState("");

  const remove = (r) =>
    removeIgnoredError(r.id)
      .then(state.reload)
      .catch((e) => setMessage("Not removed: " + errorMessage(e)));

  return (
    <div data-testid="ignored-errors">
      {message && (
        <Notice kind="error" onClose={() => setMessage("")}>
          {message}
        </Notice>
      )}
      <Loaded state={state}>
        {(rules) => (
          <DataTable
            label="ignored errors"
            data={rules}
            getRowId={(r) => r.id}
            emptyText="No errors are ignored."
            initialSort={{ id: "added", desc: true }}
            columns={[
              {
                id: "source",
                header: "Source",
                accessor: (r) => r.source || "",
                cell: (r) => (r.source ? <PathText>{r.source}</PathText> : "Any"),
              },
              {
                id: "path",
                header: "Path",
                accessor: (r) => r.path,
                cell: (r) => <PathText>{r.path || "(whole source)"}</PathText>,
              },
              { id: "scope", header: "Scope", accessor: (r) => r.scope },
              {
                id: "kind",
                header: "Error",
                accessor: (r) => r.kind || "",
                cell: (r) => (r.kind ? KIND_LABELS[r.kind] || r.kind : "any"),
              },
              {
                id: "hides",
                header: "Hides now",
                align: "end",
                accessor: (r) => (r.expired ? -1 : r.hides),
                cell: (r) => (r.expired ? "—" : <CountText n={r.hides} />),
              },
              {
                id: "added",
                header: "Added",
                accessor: (r) => r.created,
                cell: (r) => <DateTimeText value={r.created} />,
              },
              {
                id: "until",
                header: "Until",
                accessor: (r) => r.expires || "9999",
                cell: (r) =>
                  !r.expires ? (
                    "Never"
                  ) : r.expired ? (
                    <StatusBadge kind="neutral">expired</StatusBadge>
                  ) : (
                    <DateTimeText value={r.expires} />
                  ),
              },
              {
                id: "remove",
                header: "",
                align: "end",
                cell: (r) => (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={"Remove the rule for " + (r.path || "the whole source")}
                    onClick={() => remove(r)}
                  >
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Loaded>
    </div>
  );
}
