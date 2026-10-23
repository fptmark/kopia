import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Dropdown from "react-bootstrap/Dropdown";
import Form from "react-bootstrap/Form";
import Table from "react-bootstrap/Table";
import { DEFAULT_SUCCESS } from "../utils/rollup";
import { WhenField } from "./WhenField";

const DESTINATIONS_URL = "/api/v1/notifications/destinations";
const MAIL_ACCOUNTS_URL = "/api/v1/notifications/email-accounts";
const LOG_URL = "/api/v1/notifications/log?limit=15";
const LOG_POLL_MS = 30000;

// the kinds of destination that can be added, and what a new one is called
const TYPES = {
  mac: { name: "This Mac", menu: "This Mac", field: null },
  imessage: { name: "iPhone", menu: "iPhone", field: "phone number or Apple ID" },
  email: { name: "Email", menu: "Email", field: "name@example.com" },
};

// the failures a destination can choose to hear about; they are always sent as they happen
const FAILURES = [
  { id: "health", name: "Backup problem found by the health check" },
  { id: "failed", name: "Snapshot failed" },
  { id: "skipped", name: "Snapshot finished with skipped files" },
  { id: "maint", name: "Maintenance or repository problem" },
];

const SUCCESS = [
  { id: "off", name: "Off" },
  { id: "now", name: "Immediately, every snapshot" },
  { id: "daily", name: "Daily summary" },
  { id: "weekly", name: "Weekly summary" },
  { id: "monthly", name: "Monthly summary" },
];

const EVENT_NAME = {
  health: "Backup problem",
  failed: "Snapshot failed",
  skipped: "Skipped files",
  maint: "Repository problem",
  watchdog: "Server stopped",
  done: "Snapshot completed",
  summary: "Summary",
  test: "Test message",
};

const errorText = (e) => e?.response?.data?.message || e?.response?.data?.error || e?.message || "unknown error";

const scheduled = (d) => ["daily", "weekly", "monthly"].includes(d.success?.freq);

const when = (t) =>
  t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

function newDestination(type) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    name: TYPES[type].name,
    target: "",
    failures: ["health", "failed", "skipped", "maint", "watchdog"],
    success: { ...DEFAULT_SUCCESS },
  };
}

function failuresLabel(d) {
  const n = FAILURES.filter((f) => d.failures?.includes(f.id)).length;
  if (n === 0) return "None";
  if (n === FAILURES.length) return "All failures";
  return `${n} of ${FAILURES.length} failures`;
}

/** A drop-down of check boxes that floats over the page: which failures this destination is told about. */
function FailuresPicker({ d, onChange }) {
  const has = (id) => d.failures?.includes(id);
  const toggle = (id) => onChange(has(id) ? d.failures.filter((x) => x !== id) : [...(d.failures || []), id]);
  // failure types this page does not list are kept as they are
  const others = (d.failures || []).filter((id) => !FAILURES.some((f) => f.id === id));

  return (
    <Dropdown autoClose="outside">
      <Dropdown.Toggle size="sm" variant="light" className="w-100 text-start" aria-label={`Failures for ${d.name}`}>
        {failuresLabel(d)}
      </Dropdown.Toggle>
      <Dropdown.Menu className="p-2" style={{ minWidth: "19rem" }}>
        {FAILURES.map((f) => (
          <Form.Check
            key={f.id}
            type="checkbox"
            id={`${d.id}-failure-${f.id}`}
            label={f.name}
            checked={!!has(f.id)}
            onChange={() => toggle(f.id)}
          />
        ))}
        <div className="d-flex gap-3 mt-2 small">
          <Button
            variant="link"
            size="sm"
            className="p-0"
            onClick={() => onChange([...FAILURES.map((f) => f.id), ...others])}
          >
            All
          </Button>
          <Button variant="link" size="sm" className="p-0" onClick={() => onChange(others)}>
            None
          </Button>
        </div>
      </Dropdown.Menu>
    </Dropdown>
  );
}

/** The day and hour a summary is sent, edited like a date picker. */
function WhenCell({ d, onChange }) {
  const s = d.success || DEFAULT_SUCCESS;

  if (!scheduled(d)) {
    return <span className="text-muted">—</span>;
  }

  return (
    <WhenField
      name={d.name}
      freq={s.freq}
      weekday={s.weekday ?? 0}
      dom={s.dom ?? 1}
      time={s.time}
      onChange={(patch) => onChange({ ...d, success: { ...s, ...patch } })}
    />
  );
}

/** Where backup alerts go: one row per destination, then the recent messages. */
export function NotificationDestinations() {
  const [dests, setDests] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState({ kind: "", text: "" });
  const [log, setLog] = useState([]);
  const [mailAccounts, setMailAccounts] = useState([]);
  const latestRef = useRef([]);
  const saveSeqRef = useRef(0);

  const refreshLog = useCallback(
    () =>
      axios
        .get(LOG_URL)
        .then((r) => setLog(Array.isArray(r.data) ? r.data : []))
        .catch(() => {
          /* the list of recent messages is a convenience */
        }),
    [],
  );

  useEffect(() => {
    axios
      .get(DESTINATIONS_URL)
      .then((r) => {
        const list = r.data?.destinations || [];
        latestRef.current = list;
        setDests(list);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, []);

  useEffect(() => {
    refreshLog();
    const t = window.setInterval(refreshLog, LOG_POLL_MS);
    return () => window.clearInterval(t);
  }, [refreshLog]);

  // the Mail app is only asked about its accounts once there is an email destination
  const hasEmail = !!dests?.some((d) => d.type === "email");
  useEffect(() => {
    if (!hasEmail) {
      return;
    }
    axios
      .get(MAIL_ACCOUNTS_URL)
      .then((r) => setMailAccounts(r.data?.accounts || []))
      .catch((e) => setStatus({ kind: "error", text: "Unable to read the accounts in Mail: " + errorText(e) }));
  }, [hasEmail]);

  const persist = (list) => {
    const seq = ++saveSeqRef.current;
    return axios
      .put(DESTINATIONS_URL, { destinations: list })
      .then(() => {
        if (seq === saveSeqRef.current) {
          setStatus({ kind: "ok", text: "Saved." });
        }
      })
      .catch((e) => {
        if (seq === saveSeqRef.current) {
          setStatus({ kind: "error", text: "Not saved: " + errorText(e) });
        }
      });
  };

  // a change is shown at once and saved; text fields are saved when left, not on every keystroke
  const change = (list, save = true) => {
    latestRef.current = list;
    setDests(list);
    if (save) {
      persist(list);
    }
  };

  const replace = (d, save) =>
    change(
      latestRef.current.map((x) => (x.id === d.id ? d : x)),
      save,
    );

  const remove = (d) => {
    if (!window.confirm(`Delete the destination "${d.name}"?`)) {
      return;
    }
    change(latestRef.current.filter((x) => x.id !== d.id));
  };

  const test = (d) => {
    setStatus({ kind: "", text: `Sending a test message to ${d.name}…` });
    return axios
      .post(`${DESTINATIONS_URL}/${encodeURIComponent(d.id)}/test`, {})
      .then(() => setStatus({ kind: "ok", text: `Test message sent to ${d.name}.` }))
      .catch((e) => setStatus({ kind: "error", text: `Test to ${d.name} failed: ${errorText(e)}` }))
      .finally(refreshLog);
  };

  if (loadError) {
    return <Alert variant="danger">Unable to load the notification destinations: {loadError}</Alert>;
  }
  if (!dests) {
    return <p className="text-muted">Loading…</p>;
  }

  const nameOf = (id) => dests.find((d) => d.id === id)?.name || id;
  // the sending account is only a choice when Mail has more than one
  const fromChoices = mailAccounts.flatMap((a) =>
    a.addresses.map((address) => ({ address, label: `${a.name} (${address})` })),
  );

  return (
    <div data-testid="notification-destinations" className="fw-normal">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <h6 className="mb-0">Where should backup alerts go?</h6>
        <div className="d-flex align-items-center gap-2">
          {status.text && (
            <span className={"small " + (status.kind === "error" ? "text-danger" : "text-muted")} role="status">
              {status.text}
            </span>
          )}
          <Dropdown align="end">
            <Dropdown.Toggle size="sm" variant="primary">
              + Add destination
            </Dropdown.Toggle>
            <Dropdown.Menu>
              {Object.entries(TYPES).map(([type, t]) => (
                <Dropdown.Item key={type} onClick={() => change([...latestRef.current, newDestination(type)])}>
                  {t.menu}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown>
        </div>
      </div>

      {dests.length === 0 ? (
        <p className="text-muted">No destinations. Nothing is sent. Add one to be told about backup problems.</p>
      ) : (
        <Table bordered size="sm" className="align-middle mb-3" data-testid="destination-grid">
          <thead className="table-light">
            <tr>
              <th scope="col" style={{ width: "16%" }}>
                Destination
              </th>
              <th scope="col">Address</th>
              <th scope="col" style={{ width: "11rem" }}>
                Failures
              </th>
              <th scope="col" style={{ width: "13rem" }}>
                Success
              </th>
              <th scope="col" style={{ width: "1%" }}>
                When
              </th>
              <th scope="col" style={{ width: "1%" }}></th>
            </tr>
          </thead>
          <tbody>
            {dests.map((d) => (
              <tr key={d.id}>
                <td>
                  <Form.Control
                    size="sm"
                    className="fw-semibold"
                    aria-label={`Name of ${d.name}`}
                    value={d.name}
                    onChange={(e) => replace({ ...d, name: e.target.value }, false)}
                    onBlur={() => persist(latestRef.current)}
                  />
                </td>
                <td className={TYPES[d.type]?.field ? "" : "bg-body-secondary"}>
                  {TYPES[d.type]?.field && (
                    <Form.Control
                      size="sm"
                      aria-label={`Send to for ${d.name}`}
                      placeholder={TYPES[d.type].field}
                      value={d.target || ""}
                      onChange={(e) => replace({ ...d, target: e.target.value }, false)}
                      onBlur={() => persist(latestRef.current)}
                    />
                  )}
                  {d.type === "email" && fromChoices.length > 1 && (
                    <Form.Select
                      size="sm"
                      className="mt-1"
                      aria-label={`Send from for ${d.name}`}
                      value={d.from || ""}
                      onChange={(e) => replace({ ...d, from: e.target.value })}
                    >
                      <option value="">From: Mail&apos;s default account</option>
                      {fromChoices.map((c) => (
                        <option key={c.address} value={c.address}>
                          From: {c.label}
                        </option>
                      ))}
                    </Form.Select>
                  )}
                </td>
                <td>
                  <FailuresPicker d={d} onChange={(failures) => replace({ ...d, failures })} />
                </td>
                <td>
                  <Form.Select
                    size="sm"
                    aria-label={`Success messages for ${d.name}`}
                    value={d.success?.freq || "off"}
                    onChange={(e) =>
                      replace({ ...d, success: { ...DEFAULT_SUCCESS, ...d.success, freq: e.target.value } })
                    }
                  >
                    {SUCCESS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Form.Select>
                </td>
                <td className="text-nowrap">
                  <WhenCell d={d} onChange={(x) => replace(x)} />
                </td>
                <td className="text-nowrap">
                  <Button size="sm" variant="secondary" onClick={() => test(d)} aria-label={`Test ${d.name}`}>
                    Test
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(d)} aria-label={`Delete ${d.name}`}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <p className="text-muted small">
        Failures are always sent as they happen. One that keeps happening is sent once and again after 12 hours, and you
        are told when it ends. Messages contain counts, source folders and times only; file names and error details stay
        on this Mac, in the Tasks page. Email is sent through the Mail app on this Mac.
      </p>

      <section data-testid="recent-messages">
        <h6>Recent messages</h6>
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th className="text-nowrap">When</th>
              <th>Destination</th>
              <th>Message</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {log.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted">
                  Nothing has been sent yet.
                </td>
              </tr>
            )}
            {log.map((l) => (
              <tr key={`${l.sentAt}-${l.destination}-${l.event}`}>
                <td className="text-nowrap text-muted">{when(l.sentAt)}</td>
                <td>{nameOf(l.destination)}</td>
                <td>{EVENT_NAME[l.event] || l.event}</td>
                <td>
                  {l.status === "sent" ? (
                    <Badge bg="success">Sent</Badge>
                  ) : (
                    <>
                      <Badge bg="danger">Failed</Badge> <span className="small text-break">{l.error}</span>
                    </>
                  )}
                  {l.attempts > 1 && <span className="text-muted small"> · {l.attempts} tries</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </div>
  );
}
