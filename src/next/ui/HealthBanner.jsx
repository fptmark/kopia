import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import { Link } from "react-router";
import { errorMessage } from "../api";
import { formatDateTime } from "../format";
import { loadHealth, runHealthCheck } from "../health";
import { useLoad } from "../hooks";
import { Notice } from "./Feedback";

/**
 * A red banner shown on every page while a backup health check fails. Never in the way: no status, no banner.
 * The button runs the full check (an action); the link goes to the details (navigation).
 */
export function HealthBanner() {
  const [startedFrom, setStartedFrom] = useState(null);
  const [error, setError] = useState("");
  const state = useLoad(loadHealth, [], { refreshMs: startedFrom === null ? 60000 : 5000 });
  const status = state.data;

  if (!status || status.state !== "failing") {
    return null;
  }

  // checking until the server reports a full check newer than the one running when the button was pressed
  const checking = startedFrom !== null && (status.lastDeepRun ?? "") === startedFrom;

  const run = () => {
    setError("");
    setStartedFrom(status.lastDeepRun ?? "");
    runHealthCheck().catch((e) => {
      setStartedFrom(null);
      setError(errorMessage(e));
    });
  };

  return (
    <Notice kind="error" data-testid="verify-banner">
      <strong>Backup failure</strong> on {formatDateTime(status.since)}{" "}
      <Button variant="danger" size="sm" className="mx-2" disabled={checking} onClick={run}>
        {checking ? "Checking…" : "Check to clear"}
      </Button>
      <Link to="/repository">Details</Link>
      {error && <span className="ms-2">{error}</span>}
    </Notice>
  );
}
