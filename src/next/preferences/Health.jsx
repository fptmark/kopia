import React, { use, useState } from "react";
import Button from "react-bootstrap/Button";
import { Link } from "react-router";
import { errorMessage } from "../api";
import { formatDateTime } from "../format";
import { loadHealth, runHealthCheck } from "../health";
import { useLoad } from "../hooks";
import { loadVerificationFailures } from "../verification";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { DataTable, DateTimeText, Loaded, PathText, StatusBadge, SwitchField } from "../ui";

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
    <details className="mt-1" data-testid="check-failures">
      <summary>
        {check.failureCount.toLocaleString("en-US")} {check.failureCount === 1 ? "file" : "files"} failed
      </summary>
      <ul className="small mb-1 mt-1">
        {list.map((f) => (
          <li key={f.path + f.error}>
            <PathText>{f.path}</PathText>
            <div className="nx-muted">{f.error}</div>
          </li>
        ))}
      </ul>
      {more > 0 && check.verificationId > 0 && (
        <Button size="sm" variant="secondary" onClick={showAll}>
          Show all {check.failureCount.toLocaleString("en-US")}
        </Button>
      )}
      {more > 0 && !check.verificationId && <div className="nx-muted small">Showing the first {list.length}.</div>}
      {error && <div className="text-danger small">{error}</div>}
    </details>
  );
}

/** The health checks with their latest result, and a button to run the full check now. */
export function Health() {
  const { verifyNewData, setVerifyNewData } = use(UIPreferencesContext);
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
            <SwitchField
              label="Read back the data each snapshot adds"
              help="Right after every snapshot, reads back everything it wrote to the repository from the NAS and checks it. Quick, because most of a snapshot is data that was already stored. A failure shows on the History page and fails the health check for a day. Applies to snapshots that finish after the change."
              checked={verifyNewData}
              onChange={setVerifyNewData}
              data-testid="verify-new-data"
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
