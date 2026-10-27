import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import { FromLink } from "./FromLink";
import { errorMessage } from "../api";
import { formatDateTime, formatCount } from "../format";
import { loadHealth, runHealthCheck } from "../health";
import { useLoad } from "../hooks";
import { loadVerificationFailures } from "../verification";
import { DataTable } from "./DataTable";
import { Loaded } from "./Feedback";
import { DateTimeText, PathText, StatusBadge } from "./Cells";

/** The files a failed check could not read back: the first ones it kept, and all of them on request. */
function CheckFailures({ check }) {
  const [all, setAll] = useState(null);
  const [error, setError] = useState("");
  const list = all ?? check.failures ?? [];
  const more = check.failureCount - list.length;

  const showAll = () =>
    loadVerificationFailures(check.verificationId)
      .then((r) => setAll(r.failures))
      .catch((e) => setError(errorMessage(e)));

  return (
    <details data-testid="check-failures">
      <summary>
        {formatCount(check.failureCount)} {check.failureCount === 1 ? "file" : "files"} failed
      </summary>
      <ul className="small">
        {list.map((f) => (
          <li key={f.path + f.error}>
            <PathText>{f.path}</PathText>
            <div className="nx-muted">{f.error}</div>
          </li>
        ))}
      </ul>
      {more > 0 && check.verificationId > 0 && (
        <Button size="sm" variant="secondary" onClick={showAll}>
          Show all {formatCount(check.failureCount)}
        </Button>
      )}
      {more > 0 && !check.verificationId && <div className="nx-muted small">Showing the first {list.length}.</div>}
      {error && <div className="text-danger small">{error}</div>}
    </details>
  );
}

/** The health checks with their latest result, and a button to run the full check now. */
export function BackupHealth() {
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
          <div className="nx-stack" data-testid="backup-health">
            <div className="nx-row">
              <div className="nx-row">
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
                          (<FromLink to={"/tasks/" + status.lastDeepTaskId}>log</FromLink>)
                        </>
                      )}
                    </>
                  )}
                </span>
              </div>
              <div className="nx-row">
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
              emptyText="No checks yet."
              columns={[
                {
                  id: "ok",
                  header: "",
                  cell: (c) => <StatusBadge kind={c.ok ? "ok" : "error"}>{c.ok ? "passed" : "failed"}</StatusBadge>,
                },
                { id: "name", header: "Check", cell: (c) => c.name },
                {
                  id: "detail",
                  header: "Result",
                  cell: (c) => (
                    <>
                      {c.failureCount > 0 && !c.ok ? c.detail.split("; first:")[0] : c.detail}
                      {c.failureCount > 0 && <CheckFailures check={c} />}
                    </>
                  ),
                },
                { id: "at", header: "Last checked", cell: (c) => <DateTimeText value={c.checkedAt} /> },
              ]}
            />
          </div>
        );
      }}
    </Loaded>
  );
}
