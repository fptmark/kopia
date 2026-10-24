import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import { Link } from "react-router";
import { errorMessage } from "../api";
import { formatDateTime } from "../format";
import { loadHealth, runHealthCheck } from "../health";
import { useLoad } from "../hooks";
import { DataTable, DateTimeText, Loaded, StatusBadge } from "../ui";

/** The health checks with their latest result, and a button to run the full check now. */
export function Health() {
  const state = useLoad(loadHealth, [], { refreshMs: 10000 });
  const [message, setMessage] = useState("");

  const run = () =>
    runHealthCheck()
      .then(() => {
        setMessage("Check started.");
        state.refresh();
      })
      .catch((e) => setMessage("Failed: " + errorMessage(e)));

  return (
    <Loaded state={state}>
      {(status) => {
        const s = status.state;
        return (
          <div data-testid="backup-health">
            <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
              <div className="d-flex flex-wrap align-items-center gap-2">
                {s === "ok" && <StatusBadge kind="ok">Healthy</StatusBadge>}
                {s === "failing" && <StatusBadge kind="error">Problem</StatusBadge>}
                {(!s || s === "unknown") && <StatusBadge kind="neutral">Not checked yet</StatusBadge>}
                <span className="nx-muted">
                  {(s === "ok" || s === "failing") && <>since {formatDateTime(status.since)}</>}
                  {status.lastDeepRun && (
                    <>
                      {" "}
                      · full check {formatDateTime(status.lastDeepRun)}
                      {status.lastDeepTaskId && (
                        <>
                          {" "}
                          (<Link to={"/tasks/" + status.lastDeepTaskId}>log</Link>)
                        </>
                      )}
                    </>
                  )}
                </span>
              </div>
              <div className="d-flex align-items-center gap-2">
                {message && <span className="nx-muted small">{message}</span>}
                <Button variant="primary" onClick={run}>
                  Run full check now
                </Button>
              </div>
            </div>
            <DataTable
              label="health checks"
              data={status.checks || []}
              getRowId={(c) => c.name}
              footer={false}
              emptyText="The first check runs shortly after the server starts."
              columns={[
                {
                  id: "ok",
                  header: "",
                  cell: (c) => <StatusBadge kind={c.ok ? "ok" : "error"}>{c.ok ? "passed" : "failed"}</StatusBadge>,
                },
                { id: "name", header: "Check", cell: (c) => c.name },
                { id: "detail", header: "Result", cell: (c) => c.detail },
                { id: "at", header: "Last checked", cell: (c) => <DateTimeText value={c.checkedAt} /> },
              ]}
            />
            <p className="nx-muted small">
              Snapshot checks run every 10 minutes. The data and restore checks run once a day, early in the morning. A
              failed check stays failed until the next full check passes. Who is told about a problem is set under
              Notifications.
            </p>
          </div>
        );
      }}
    </Loaded>
  );
}
