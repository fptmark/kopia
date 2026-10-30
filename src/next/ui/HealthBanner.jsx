import React, { useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import OverlayTrigger from "react-bootstrap/OverlayTrigger";
import Tooltip from "react-bootstrap/Tooltip";
import { Link } from "react-router";
import { errorMessage } from "../api";
import { formatDateTime } from "../format";
import { hasOtherFailingChecks, loadHealth } from "../health";
import { useLoad } from "../hooks";
import { loadSources, sourcePathFromString } from "../snapshots";
import { dismissVerifications, groupVerifications, loadVerifications, verifySnapshots } from "../verification";
import { DateTimeText, StatusBadge } from "./Cells";
import { Notice } from "./Feedback";
import { TIP_DELAY, VerifyDialog, VerifyFailuresDialog, VerifyProgress } from "./Verification";

const SHOWN_COLLAPSED = 2;

// "new" is its own bucket; sample and full share one, matching how the server tracks the latest of each.
const sameBucket = (a, b) => (a === "new") === (b === "new");

function FailRow({ item, running, onVerify, onDetails, onClear, verifying }) {
  const path = sourcePathFromString(item.source);
  const inFlight = running.find((r) => sameBucket(r.mode, item.mode));

  return (
    <div className="nx-fail-row" data-testid="verify-banner-row">
      <div className="nx-fail-left">
        <span className="nx-fail-src" title={path}>
          {path}
        </span>
        <DateTimeText value={item.finishedAt} />
        <OverlayTrigger placement="top" delay={TIP_DELAY} overlay={<Tooltip>{item.detail}</Tooltip>}>
          <span>
            <StatusBadge kind="error">{item.badge}</StatusBadge>
          </span>
        </OverlayTrigger>
      </div>
      <div className="nx-fail-actions">
        {inFlight ? (
          <VerifyProgress r={inFlight} />
        ) : (
          <Button variant="danger" size="sm" disabled={verifying} onClick={() => onVerify(item)}>
            {verifying ? "Starting…" : "Verify"}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => onDetails(item)}>
          Details
        </Button>
        <button
          type="button"
          className="btn btn-sm nx-icon-btn"
          title="Clear this failure"
          aria-label="Clear this failure"
          onClick={() => onClear([item.id])}
        >
          &times;
        </button>
      </div>
    </div>
  );
}

/** The redesigned part of the banner: one row per failing snapshot, each with its own Verify, Details and
 * clear, a header Clear all, and a "Show N more" for anything past the first two. */
function SnapshotFailures({ items, onCleared }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(null);
  const [startingIds, setStartingIds] = useState(() => new Set());

  const snapshotIds = useMemo(() => [...new Set(items.map((it) => it.snapshotId))], [items]);
  const running = useLoad(() => loadVerifications(snapshotIds), [snapshotIds.join(",")], {
    enabled: snapshotIds.length > 0,
    refreshMs: 4000,
  });
  const bySnapshot = useMemo(() => groupVerifications(running.data), [running.data]);

  const visible = expanded ? items : items.slice(0, SHOWN_COLLAPSED);
  const hidden = items.length - visible.length;

  const verify = (item) => {
    setError("");
    setStartingIds((s) => new Set(s).add(item.id));
    verifySnapshots([item.snapshotId], item.mode, item.mode === "sample" ? item.percent : 100)
      .then(() => running.reload())
      .catch((e) => setError("Not started: " + errorMessage(e)))
      .finally(() =>
        setStartingIds((s) => {
          const n = new Set(s);
          n.delete(item.id);
          return n;
        }),
      );
  };

  const clear = (ids) => {
    setError("");
    dismissVerifications(ids)
      .then(() => onCleared())
      .catch((e) => setError("Not cleared: " + errorMessage(e)));
  };

  return (
    <>
      <div className="nx-row">
        <strong>
          {items.length === 1 ? "1 snapshot failed verification" : `${items.length} snapshots failed verification`}
        </strong>
        <Button variant="secondary" size="sm" className="nx-end" onClick={() => clear(items.map((it) => it.id))}>
          Clear all
        </Button>
      </div>
      <div className="nx-fail-list">
        {visible.map((it) => (
          <FailRow
            key={it.id}
            item={it}
            running={bySnapshot[it.snapshotId]?.running ?? []}
            verifying={startingIds.has(it.id)}
            onVerify={verify}
            onDetails={setDetails}
            onClear={clear}
          />
        ))}
      </div>
      {items.length > SHOWN_COLLAPSED && (
        <div className="nx-row">
          <Button variant="secondary" size="sm" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </Button>
        </div>
      )}
      {error && <span className="text-danger">{error}</span>}
      {details && <VerifyFailuresDialog verification={details} onClose={() => setDetails(null)} />}
    </>
  );
}

/** The old, aggregate banner: used only when something is failing that has no single snapshot to verify, such
 * as a source gone stale or exclusion rules out of sync with policy. */
function AggregateFailure({ since }) {
  const [ids, setIds] = useState([]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verifying = useLoad(() => loadVerifications(ids), [ids], { enabled: ids.length > 0, refreshMs: 3000 });
  const running = ids.length > 0 && (verifying.data?.running?.length ?? 0) > 0;

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
    <>
      <div className="nx-inline">
        <strong>Backup failure</strong> on {formatDateTime(since)}
        <Button variant="danger" size="sm" disabled={busy || running} onClick={open}>
          {running ? "Verifying…" : "Verify"}
        </Button>
        <Link to="/repo">Details</Link>
      </div>
      {error && <span>{error}</span>}
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
    </>
  );
}

/**
 * A red banner shown on every page while a backup health check fails: one row per failing snapshot (Verify,
 * Details and a clear act on that snapshot alone), a header Clear all, and a "Show N more" past the first two.
 * Falls back to a single aggregate notice for a failure with no snapshot of its own, such as staleness. Never
 * in the way: no status, no banner.
 */
export function HealthBanner() {
  const state = useLoad(loadHealth, [], { refreshMs: 60000 });
  const status = state.data;

  if (!status) {
    return null;
  }

  const items = status.failingSnapshots ?? [];
  // a cleared item drops out of failingSnapshots right away; status.state itself only catches up at the next
  // check, so it stays "failing" until then -- show nothing rather than falling back to the aggregate notice.
  const otherFailing = status.state === "failing" && hasOtherFailingChecks(status);

  if (items.length === 0 && !otherFailing) {
    return null;
  }

  return (
    <Notice kind="error" data-testid="verify-banner">
      {items.length > 0 ? (
        <SnapshotFailures items={items} onCleared={() => state.reload()} />
      ) : (
        <AggregateFailure since={status.since} />
      )}
    </Notice>
  );
}
