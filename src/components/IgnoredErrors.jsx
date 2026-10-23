import { useCallback, useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Table from "react-bootstrap/Table";
import { KIND_LABELS, listIgnoredErrors, removeIgnoredError } from "../utils/ignoredErrors";

const errorText = (e) => e?.response?.data?.message || e?.message || "unknown error";

function what(rule) {
  const kind = rule.kind ? KIND_LABELS[rule.kind] || rule.kind : "any error";
  if (rule.scope === "file") {
    return kind + " on this file";
  }
  return kind + (rule.path ? " in this folder" : " in this source");
}

function expiry(rule) {
  if (!rule.expires) {
    return "Never";
  }
  const date = new Date(rule.expires).toLocaleDateString();
  return rule.expired ? "Expired " + date : date;
}

/**
 * The errors that are not reported: hidden from failure counts and alerts, though the snapshot still records
 * them. Rules are added from the failed files dialog of a snapshot.
 */
export function IgnoredErrors() {
  const [rules, setRules] = useState(null);
  const [message, setMessage] = useState("");

  const load = useCallback(() => {
    listIgnoredErrors()
      .then(setRules)
      .catch((e) => setMessage("Unable to load the ignored errors: " + errorText(e)));
  }, []);

  useEffect(load, [load]);

  const remove = (rule) =>
    removeIgnoredError(rule.id)
      .then(load)
      .catch((e) => setMessage("Not removed: " + errorText(e)));

  if (rules === null && !message) {
    return null;
  }

  return (
    <div className="mt-4" data-testid="ignored-errors">
      <h5>Ignored errors</h5>
      <div className="text-muted small mb-2">
        Hidden from failure counts and alerts. The snapshot still records them. Add one with Ignore in the failed files
        of a snapshot, on the Tasks page.
      </div>
      {message && (
        <div className="text-danger small mb-2" role="alert">
          {message}
        </div>
      )}
      {rules && rules.length === 0 && <div className="text-muted">No errors are ignored.</div>}
      {rules && rules.length > 0 && (
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Source</th>
              <th>Path</th>
              <th>Ignores</th>
              <th>Hides now</th>
              <th>Until</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className={r.expired ? "text-muted" : ""} data-testid="ignored-error-row">
                <td>{r.source ? <code>{r.source}</code> : "Any source"}</td>
                <td>
                  <code style={{ wordBreak: "break-all" }}>{r.path || "(whole source)"}</code>
                </td>
                <td>{what(r)}</td>
                <td>{r.expired ? "—" : r.hides.toLocaleString()}</td>
                <td>{expiry(r)}</td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={"Remove the rule for " + r.path}
                    onClick={() => remove(r)}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
