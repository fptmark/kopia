import axios from "axios";
import { use, useCallback, useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
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

/** The health checks with their latest result, the iMessage recipient, and buttons to try things out. */
export function BackupHealthPanel() {
  const { verifierIMessageTo, setVerifierIMessageTo } = use(UIPreferencesContext);
  const [status, refresh] = useVerifyStatus(10000);
  const [recipient, setRecipient] = useState(verifierIMessageTo || "");
  const [message, setMessage] = useState("");

  useEffect(() => setRecipient(verifierIMessageTo || ""), [verifierIMessageTo]);

  const post = (url, ok) =>
    axios
      .post(url, {})
      .then(() => {
        setMessage(ok);
        return refresh();
      })
      .catch((e) => setMessage("Failed: " + (e?.response?.data?.message || e.message)));

  const checks = status?.checks || [];

  return (
    <div data-testid="backup-health">
      <p>
        {!status || status.state === "unknown" ? (
          <>No health check has completed yet.</>
        ) : status.state === "ok" ? (
          <span className="text-success">Healthy since {formatDateTime(status.since)}.</span>
        ) : (
          <span className="text-danger">Failing since {formatDateTime(status.since)}.</span>
        )}
        {status?.lastRun && <> Last run {formatDateTime(status.lastRun)}.</>}
        {status?.lastDeepRun && (
          <>
            {" "}
            Last full check {formatDateTime(status.lastDeepRun)}
            {status.lastDeepTaskId && (
              <>
                {" "}
                (<Link to={`/tasks/${status.lastDeepTaskId}`}>details</Link>)
              </>
            )}
            .
          </>
        )}
      </p>

      <ul className="list-unstyled">
        {checks.map((c) => (
          <li key={c.name} className={c.ok ? "" : "text-danger"}>
            {c.ok ? "✓" : "✗"} <strong>{c.name}</strong>: {c.detail}
          </li>
        ))}
      </ul>

      <Form.Group controlId="verifierIMessageTo" className="mb-3">
        <Form.Label>Send an iMessage to when a check fails</Form.Label>
        <Form.Control
          size="sm"
          type="text"
          placeholder="phone number or Apple ID (leave empty for a Mac notification only)"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          onBlur={() => recipient !== (verifierIMessageTo || "") && setVerifierIMessageTo(recipient.trim())}
        />
        <Form.Text muted>
          Sent through the Messages app on this Mac, so it needs to be signed in. The first message asks for permission
          to control Messages.
        </Form.Text>
      </Form.Group>

      <Button size="sm" variant="primary" className="me-2" onClick={() => post("/api/v1/verify/run", "Check started.")}>
        Run full check now
      </Button>
      <Button
        size="sm"
        variant="outline-secondary"
        onClick={() => post("/api/v1/verify/test-notification", "Test message sent.")}
      >
        Send test message
      </Button>
      {message && <span className="ms-3">{message}</span>}
    </div>
  );
}
