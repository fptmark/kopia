import { useCallback, useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Table from "react-bootstrap/Table";
import { KIND_LABELS, listIgnoredErrors, removeIgnoredError } from "../utils/ignoredErrors";

const errorText = (e) => e?.response?.data?.message || e?.message || "unknown error";

const day = (t) => new Date(t).toLocaleDateString();

function until(rule) {
  if (!rule.expires) {
    return "Never";
  }
  return rule.expired ? "Expired " + day(rule.expires) : day(rule.expires);
}

/** The errors that are not reported, one rule per row. Rules are added from the failed files of a snapshot. */
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

  return (
    <div data-testid="ignored-errors">
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
              <th>Scope</th>
              <th>Error</th>
              <th className="text-end">Hides</th>
              <th>Added</th>
              <th>Until</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className={r.expired ? "text-muted" : ""} data-testid="ignored-error-row">
                <td>{r.source ? <code>{r.source}</code> : "Any"}</td>
                <td>
                  <code style={{ wordBreak: "break-all" }}>{r.path || "(whole source)"}</code>
                </td>
                <td>{r.scope}</td>
                <td>{r.kind ? KIND_LABELS[r.kind] || r.kind : "any"}</td>
                <td className="text-end">{r.expired ? "—" : r.hides.toLocaleString()}</td>
                <td>{day(r.created)}</td>
                <td>{until(r)}</td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={"Remove the rule for " + (r.path || "the whole source")}
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
