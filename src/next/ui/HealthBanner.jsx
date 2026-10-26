import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import { Link } from "react-router";
import { errorMessage } from "../api";
import { formatDateTime } from "../format";
import { loadHealth } from "../health";
import { useLoad } from "../hooks";
import { loadSources } from "../snapshots";
import { loadVerifications, verifySnapshots } from "../verification";
import { Notice } from "./Feedback";
import { VerifyDialog } from "./Verification";

/**
 * A red banner shown on every page while a backup health check fails. Never in the way: no status, no banner.
 * The button verifies the newest snapshot of every source, with the same options as the Verify button on the
 * History page, and a pass clears the failure; the link goes to the details (navigation).
 */
export function HealthBanner() {
  const [ids, setIds] = useState([]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verifying = useLoad(() => loadVerifications(ids), [ids], { enabled: ids.length > 0, refreshMs: 3000 });
  const running = ids.length > 0 && (verifying.data?.running?.length ?? 0) > 0;
  const state = useLoad(loadHealth, [], { refreshMs: running ? 5000 : 60000 });
  const status = state.data;

  if (!status || status.state !== "failing") {
    return null;
  }

  const open = () => {
    setError("");
    setBusy(true);
    loadSources()
      .then((d) => {
        const newest = (d.sources || []).map((r) => r.lastSnapshot?.id).filter(Boolean);
        if (newest.length === 0) {
          setError("There are no snapshots to verify.");
          return;
        }
        setIds(newest);
        setAsking(true);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const start = (mode, percent) => {
    setBusy(true);
    verifySnapshots(ids, mode, percent)
      .then(() => {
        setAsking(false);
        verifying.reload();
      })
      .catch((e) => {
        setIds([]);
        setError("Not started: " + errorMessage(e));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Notice kind="error" data-testid="verify-banner">
      <strong>Backup failure</strong> on {formatDateTime(status.since)}{" "}
      <Button variant="danger" size="sm" className="mx-2" disabled={busy || running} onClick={open}>
        {running ? "Verifying…" : "Verify"}
      </Button>
      <Link to="/repository">Details</Link>
      {error && <span className="ms-2">{error}</span>}
      {asking && (
        <VerifyDialog
          count={ids.length}
          busy={busy}
          onStart={start}
          onCancel={() => {
            setAsking(false);
            setIds([]);
          }}
        />
      )}
    </Notice>
  );
}
