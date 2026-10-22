import axios from "axios";
import { use, useCallback, useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Table from "react-bootstrap/Table";
import { Link } from "react-router";
import { UIPreferencesContext } from "../contexts/UIPreferencesContext";
import { rfc3339TimestampForDisplay as formatDateTime } from "../utils/formatutils";

const STATUS_URL = "/api/v1/verify/status";
const POLL_MS = 60000;

function useVerifyStatus(intervalMs = POLL_MS) {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(() => {
    return axios
      .get(STATUS_URL)
      .then((result) => setStatus(result.data))
      .catch(() => {
        /* the banner must never get in the way; the status is simply unknown */
      });
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(t);
  }, [refresh, intervalMs]);

  return [status, refresh];
}

/** A red banner shown on every page while a backup health check fails. */
export function VerifyBanner() {
  const [status] = useVerifyStatus();

  if (!status || status.state !== "failing") {
    return null;
  }

  const failed = (status.checks || []).filter((c) => !c.ok);

  return (
    <Alert variant="danger" data-testid="verify-banner" className="mb-3">
      <strong>Backup problem</strong> since {formatDateTime(status.since)}
      <ul className="mb-1 mt-1">
        {failed.map((c) => (
          <li key={c.name}>
            {c.name}: {c.detail}
          </li>
        ))}
      </ul>
      <Link to="/tasks">See the Tasks page</Link> · <Link to="/preferences">Backup health</Link>
    </Alert>
  );
}

const when = (t) =>
  t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

/** The health checks with their latest result, the iMessage recipient, and buttons to try things out. */
export function BackupHealthPanel() {
  const { verifierIMessageTo, setVerifierIMessageTo } = use(UIPreferencesContext);
  const [status, refresh] = useVerifyStatus(10000);
  // what is being typed, or null when the field shows the saved value
  const [draft, setDraft] = useState(null);
  const recipient = draft ?? (verifierIMessageTo || "");
  const [message, setMessage] = useState("");

  const post = (url, ok) =>
    axios
      .post(url, {})
      .then(() => {
        setMessage(ok);
        return refresh();
      })
      .catch((e) => setMessage("Failed: " + (e?.response?.data?.message || e.message)));

  const checks = status?.checks || [];
  const state = status?.state;

  return (
    <div data-testid="backup-health" className="fw-normal">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <div className="d-flex flex-wrap align-items-center gap-2">
          {state === "ok" && <Badge bg="success">Healthy</Badge>}
          {state === "failing" && <Badge bg="danger">Problem</Badge>}
          {(!state || state === "unknown") && <Badge bg="secondary">Not checked yet</Badge>}
          <span className="text-muted">
            {state === "ok" && <>since {when(status.since)}</>}
            {state === "failing" && <>since {when(status.since)}</>}
            {status?.lastDeepRun && (
              <>
                {" "}
                · full check {when(status.lastDeepRun)}
                {status.lastDeepTaskId && (
                  <>
                    {" "}
                    (<Link to={`/tasks/${status.lastDeepTaskId}`}>log</Link>)
                  </>
                )}
              </>
            )}
          </span>
        </div>
        <div className="d-flex align-items-center gap-2">
          {message && <span className="text-muted small">{message}</span>}
          <Button size="sm" variant="primary" onClick={() => post("/api/v1/verify/run", "Check started.")}>
            Run full check now
          </Button>
        </div>
      </div>

      <Table size="sm" className="align-middle" data-testid="health-checks">
        <thead>
          <tr>
            <th style={{ width: "2rem" }}></th>
            <th>Check</th>
            <th>Result</th>
            <th className="text-nowrap">Last checked</th>
          </tr>
        </thead>
        <tbody>
          {checks.length === 0 && (
            <tr>
              <td colSpan={4} className="text-muted">
                The first check runs shortly after the server starts.
              </td>
            </tr>
          )}
          {checks.map((c) => (
            <tr key={c.name} className={c.ok ? "" : "table-danger"}>
              <td className={c.ok ? "text-success" : "text-danger"} aria-label={c.ok ? "passed" : "failed"}>
                {c.ok ? "✓" : "✗"}
              </td>
              <td className="text-nowrap">{c.name}</td>
              <td className="text-break">{c.detail}</td>
              <td className="text-nowrap text-muted">{when(c.checkedAt)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-muted small">
        Snapshot checks run every 10 minutes. The data and restore checks run once a day, early in the morning. A failed
        check stays failed until the next full check passes.
      </p>

      <h6 className="mt-4">Alerts</h6>
      <Form.Group controlId="verifierIMessageTo" className="mb-2" style={{ maxWidth: "26rem" }}>
        <Form.Label className="mb-1">iMessage to</Form.Label>
        <Form.Control
          size="sm"
          type="text"
          placeholder="phone number or Apple ID"
          value={recipient}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && draft.trim() !== (verifierIMessageTo || "")) {
              setVerifierIMessageTo(draft.trim());
            }
            setDraft(null);
          }}
        />
        <Form.Text muted>
          Leave empty for a Mac notification only. Sent through the Messages app on this Mac; the first message asks
          permission to control Messages.
        </Form.Text>
      </Form.Group>
      <Button
        size="sm"
        variant="outline-primary"
        onClick={() => post("/api/v1/verify/test-notification", "Test message sent.")}
      >
        Send test message
      </Button>
    </div>
  );
}
