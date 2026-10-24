import React from "react";
import { Link } from "react-router";
import { failingChecks, loadHealth } from "../health";
import { formatDateTime } from "../format";
import { useLoad } from "../hooks";
import { Notice } from "./Feedback";

/** A red banner shown on every page while a backup health check fails. Never in the way: no status, no banner. */
export function HealthBanner() {
  const state = useLoad(loadHealth, [], { refreshMs: 60000 });
  const status = state.data;

  if (!status || status.state !== "failing") {
    return null;
  }

  return (
    <Notice kind="error" title="Backup problem" data-testid="verify-banner">
      since {formatDateTime(status.since)}
      <ul className="mb-1 mt-1">
        {failingChecks(status).map((c) => (
          <li key={c.name}>
            {c.name}: {c.detail}
          </li>
        ))}
      </ul>
      <Link to="/tasks">See the Tasks page</Link> · <Link to="/preferences?tab=health">Backup health</Link>
    </Notice>
  );
}
