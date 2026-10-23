import axios from "axios";
import { useCallback, useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Table from "react-bootstrap/Table";
import { addIgnorePattern, removeIgnorePattern } from "../utils/ignoredErrors";

const errorText = (e) => e?.response?.data?.message || e?.message || "unknown error";

const GLOBAL = { userName: "", host: "", path: "" };

const isGlobal = (t) => !t.userName && !t.host && !t.path;

const keyOf = (t) => [t.userName, t.host, t.path].join("\u0000");

/** What a policy applies to, in a word or two. */
function scopeLabel(t) {
  if (isGlobal(t)) {
    return "Everything";
  }
  return t.path || t.userName + "@" + t.host;
}

/**
 * Every ignore pattern of every policy, in one table: the files that are left out of snapshots. Patterns
 * are the ones of the policy editor (Policies, Files, Ignore Rules).
 */
export function ExcludedFiles() {
  const [rows, setRows] = useState(null); // {pattern, target}
  const [targets, setTargets] = useState([GLOBAL]);
  const [pattern, setPattern] = useState("");
  const [scope, setScope] = useState(keyOf(GLOBAL));
  const [message, setMessage] = useState("");

  const load = useCallback(() => {
    Promise.all([axios.get("/api/v1/policies"), axios.get("/api/v1/sources").catch(() => ({ data: {} }))])
      .then(([pol, src]) => {
        const policies = pol.data.policies || [];
        const found = new Map([[keyOf(GLOBAL), GLOBAL]]);
        for (const s of src.data.sources || []) {
          found.set(keyOf(s.source), s.source);
        }
        for (const p of policies) {
          found.set(keyOf(p.target), p.target);
        }

        setTargets([...found.values()]);
        setRows(
          policies
            .flatMap((p) => (p.policy?.files?.ignore || []).map((pat) => ({ pattern: pat, target: p.target })))
            .sort(
              (a, b) =>
                isGlobal(b.target) - isGlobal(a.target) ||
                scopeLabel(a.target).localeCompare(scopeLabel(b.target)) ||
                a.pattern.localeCompare(b.pattern),
            ),
        );
      })
      .catch((e) => setMessage("Unable to load the policies: " + errorText(e)));
  }, []);

  useEffect(load, [load]);

  const change = (promise, failure) =>
    promise
      .then(() => {
        setMessage("");
        load();
      })
      .catch((e) => setMessage(failure + errorText(e)));

  const add = (e) => {
    e.preventDefault();
    const text = pattern.trim();
    if (!text) {
      return;
    }
    change(addIgnorePattern(targets.find((t) => keyOf(t) === scope) || GLOBAL, text), "Not added: ").then(() =>
      setPattern(""),
    );
  };

  return (
    <div data-testid="excluded-files">
      <Form className="d-flex flex-wrap align-items-center gap-2 mb-3" onSubmit={add}>
        <Form.Control
          size="sm"
          style={{ width: "22em" }}
          placeholder="/Library/Caches or *.tmp"
          aria-label="Pattern"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
        <Form.Select
          size="sm"
          style={{ width: "auto", maxWidth: "24em" }}
          aria-label="Applies to"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {targets.map((t) => (
            <option key={keyOf(t)} value={keyOf(t)}>
              {scopeLabel(t)}
            </option>
          ))}
        </Form.Select>
        <Button size="sm" variant="primary" type="submit" disabled={!pattern.trim()}>
          Exclude
        </Button>
        {message && (
          <span className="small text-danger" role="alert">
            {message}
          </span>
        )}
      </Form>
      {rows && rows.length === 0 && <div className="text-muted">Nothing is excluded.</div>}
      {rows && rows.length > 0 && (
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Applies to</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={keyOf(r.target) + r.pattern} data-testid="excluded-row">
                <td>
                  <code style={{ wordBreak: "break-all" }}>{r.pattern}</code>
                </td>
                <td>{scopeLabel(r.target)}</td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={"Stop excluding " + r.pattern}
                    onClick={() => change(removeIgnorePattern(r.target, r.pattern), "Not removed: ")}
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
