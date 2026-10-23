import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Table from "react-bootstrap/Table";
import { DEFAULT_ROLLUP, joinTime, nextRollup, parseTime, WEEKDAYS } from "../utils/rollup";

const DESTINATIONS_URL = "/api/v1/notifications/destinations";
const LOG_URL = "/api/v1/notifications/log?limit=15";
const LOG_POLL_MS = 30000;

const TYPES = {
  imessage: { label: "iMessage", field: "phone number or Apple ID" },
  mac: { label: "This Mac", field: null },
};

const EVENTS = [
  {
    id: "health",
    name: "Backup problem found or recovered",
    hint: "Health check: stale snapshots, many skipped files, a failed restore test. Repeats every 12 hours while it lasts.",
    modes: ["off", "now"],
  },
  { id: "failed", name: "Snapshot failed", hint: "A snapshot could not complete.", modes: ["off", "now", "roll"] },
  {
    id: "skipped",
    name: "Snapshot finished with skipped files",
    hint: "Completed, but some files could not be read.",
    modes: ["off", "now", "roll"],
  },
  {
    id: "maint",
    name: "Maintenance or repository problem",
    hint: "For example the NAS cannot be reached.",
    modes: ["off", "now", "roll"],
  },
];

const MODE_LABEL = { off: "Off", now: "Immediately", roll: "Roll-up" };
const MODE_CLASS = {
  off: "text-muted",
  now: "bg-primary-subtle border-primary",
  roll: "bg-warning-subtle border-warning",
};
const EVENT_NAME = { ...Object.fromEntries(EVENTS.map((e) => [e.id, e.name])), test: "Test message" };

const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const errorText = (e) => e?.response?.data?.message || e?.response?.data?.error || e?.message || "unknown error";

const modeOf = (d, id) => d.events?.[id] || "off";
const hasRoll = (d) => EVENTS.some((e) => modeOf(d, e.id) === "roll");

const fmtNext = (dt) =>
  dt.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const when = (t) =>
  t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

function newDestination(type) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    name: TYPES[type].label,
    target: "",
    events: { health: "now", failed: "now", skipped: "off", maint: "now" },
    rollup: { ...DEFAULT_ROLLUP },
  };
}

function ScheduleCell({ d, onChange }) {
  const r = d.rollup || DEFAULT_ROLLUP;
  const tm = parseTime(r.time);
  const set = (patch) => onChange({ ...d, rollup: { ...r, ...patch } });
  const setTime = (patch) => {
    const t = { ...tm, ...patch };
    set({ time: joinTime(t.h, t.m, t.ap) });
  };
  const minutes = MINUTES.includes(tm.m) ? MINUTES : [...MINUTES, tm.m].sort((a, b) => a - b);

  return (
    <div className={"d-flex flex-column gap-1" + (hasRoll(d) ? "" : " opacity-50")}>
      <Form.Select
        size="sm"
        aria-label={`How often for ${d.name}`}
        value={r.freq}
        onChange={(e) => set({ freq: e.target.value })}
      >
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </Form.Select>
      {r.freq === "weekly" && (
        <Form.Select
          size="sm"
          aria-label={`Day of week for ${d.name}`}
          value={r.weekday ?? 0}
          onChange={(e) => set({ weekday: Number(e.target.value) })}
        >
          {WEEKDAYS.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </Form.Select>
      )}
      {r.freq === "monthly" && (
        <Form.Select
          size="sm"
          aria-label={`Day of month for ${d.name}`}
          value={r.dom ?? 1}
          onChange={(e) => set({ dom: Number(e.target.value) })}
        >
          {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              Day {n}
            </option>
          ))}
          <option value={0}>Last day</option>
        </Form.Select>
      )}
      <div className="d-flex gap-1">
        <Form.Select
          size="sm"
          aria-label={`Hour for ${d.name}`}
          value={tm.h}
          onChange={(e) => setTime({ h: Number(e.target.value) })}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </Form.Select>
        <Form.Select
          size="sm"
          aria-label={`Minute for ${d.name}`}
          value={tm.m}
          onChange={(e) => setTime({ m: Number(e.target.value) })}
        >
          {minutes.map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, "0")}
            </option>
          ))}
        </Form.Select>
        <Form.Select
          size="sm"
          aria-label={`AM or PM for ${d.name}`}
          value={tm.ap}
          onChange={(e) => setTime({ ap: e.target.value })}
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </Form.Select>
      </div>
    </div>
  );
}

function Bubble({ d, m }) {
  if (d.type === "mac") {
    return (
      <div className="border rounded-3 p-2 bg-body-tertiary" data-testid="preview-message">
        <div className="fw-semibold small">{m.title}</div>
        <div className="small">{m.body}</div>
        <div className="text-muted" style={{ fontSize: "0.7rem" }}>
          Kopia
        </div>
      </div>
    );
  }
  return (
    <div
      className="align-self-end text-white rounded-4 px-3 py-2"
      style={{ background: "#2b6ef0", maxWidth: "92%", whiteSpace: "pre-line", overflowWrap: "anywhere" }}
      data-testid="preview-message"
    >
      <strong>{m.title}</strong>
      {"\n"}
      {m.body}
    </div>
  );
}

/** Which destinations hear about which events, and when: one grid, then a preview and the recent messages. */
export function NotificationDestinations() {
  const [dests, setDests] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState({ kind: "", text: "" });
  const [preview, setPreview] = useState(null);
  const [log, setLog] = useState([]);
  const [revision, setRevision] = useState(0);
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
        setSelected(list[0]?.id || "");
      })
      .catch((e) => setLoadError(errorText(e)));
  }, []);

  useEffect(() => {
    refreshLog();
    const t = window.setInterval(refreshLog, LOG_POLL_MS);
    return () => window.clearInterval(t);
  }, [refreshLog]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    axios
      .get(`/api/v1/notifications/preview?destination=${encodeURIComponent(selected)}`)
      .then((r) => setPreview(r.data))
      .catch(() => setPreview(null));
  }, [selected, revision]);

  const persist = (list) => {
    const seq = ++saveSeqRef.current;
    return axios
      .put(DESTINATIONS_URL, { destinations: list })
      .then(() => {
        if (seq === saveSeqRef.current) {
          setStatus({ kind: "ok", text: "Saved." });
          setRevision((n) => n + 1);
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

  const add = (type) => {
    const d = newDestination(type);
    setSelected(d.id);
    change([...latestRef.current, d]);
  };

  const remove = (d) => {
    if (!window.confirm(`Delete the destination "${d.name}"?`)) {
      return;
    }
    const list = latestRef.current.filter((x) => x.id !== d.id);
    if (selected === d.id) {
      setSelected(list[0]?.id || "");
    }
    change(list);
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

  const sel = dests.find((d) => d.id === selected) || dests[0];
  const nameOf = (id) => dests.find((d) => d.id === id)?.name || id;
  const anyRoll = dests.some(hasRoll);

  return (
    <div data-testid="notification-destinations" className="fw-normal">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <h6 className="mb-0">When should each destination be told?</h6>
        <div className="d-flex align-items-center gap-2">
          {status.text && (
            <span className={"small " + (status.kind === "error" ? "text-danger" : "text-muted")} role="status">
              {status.text}
            </span>
          )}
          <AddDestination onAdd={add} />
        </div>
      </div>

      {dests.length === 0 ? (
        <p className="text-muted">No destinations. Nothing is sent. Add one to be told about backup problems.</p>
      ) : (
        <div className="table-responsive">
          <Table
            bordered
            size="sm"
            className="align-top mb-2"
            style={{ minWidth: "46rem" }}
            data-testid="destination-grid"
          >
            <thead className="table-light">
              <tr>
                <th scope="col" style={{ width: "17rem" }} className="text-muted small text-uppercase align-bottom">
                  Event
                </th>
                {dests.map((d) => (
                  <th scope="col" key={d.id} className="fw-normal">
                    <div className="d-flex flex-column gap-1">
                      <div className="d-flex justify-content-between align-items-center gap-1">
                        <span className="text-muted small">{TYPES[d.type]?.label || d.type}</span>
                        <span className="d-flex gap-1">
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            className="py-0"
                            onClick={() => test(d)}
                            aria-label={`Test ${d.name}`}
                          >
                            Test
                          </Button>
                          <Button
                            size="sm"
                            variant="outline-danger"
                            className="py-0"
                            onClick={() => remove(d)}
                            aria-label={`Delete ${d.name}`}
                          >
                            Delete
                          </Button>
                        </span>
                      </div>
                      <Form.Control
                        size="sm"
                        className="fw-semibold"
                        aria-label={`Name of ${d.name}`}
                        value={d.name}
                        onFocus={() => setSelected(d.id)}
                        onChange={(e) => replace({ ...d, name: e.target.value }, false)}
                        onBlur={() => persist(latestRef.current)}
                      />
                      {TYPES[d.type]?.field ? (
                        <Form.Control
                          size="sm"
                          aria-label={`Send to for ${d.name}`}
                          placeholder={TYPES[d.type].field}
                          value={d.target || ""}
                          onFocus={() => setSelected(d.id)}
                          onChange={(e) => replace({ ...d, target: e.target.value }, false)}
                          onBlur={() => persist(latestRef.current)}
                        />
                      ) : (
                        <span className="text-muted small">Notification Center</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENTS.map((e) => (
                <tr key={e.id}>
                  <td>
                    <div className="fw-medium">{e.name}</div>
                    <div className="text-muted small">{e.hint}</div>
                  </td>
                  {dests.map((d) => (
                    <td key={d.id}>
                      <Form.Select
                        size="sm"
                        className={MODE_CLASS[modeOf(d, e.id)]}
                        aria-label={`${e.name} for ${d.name}`}
                        value={modeOf(d, e.id)}
                        onChange={(ev) => {
                          setSelected(d.id);
                          replace({ ...d, events: { ...d.events, [e.id]: ev.target.value } });
                        }}
                      >
                        {e.modes.map((m) => (
                          <option key={m} value={m}>
                            {MODE_LABEL[m]}
                          </option>
                        ))}
                      </Form.Select>
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td>
                  <div className="fw-medium">Roll-up schedule</div>
                  <div className="text-muted small">
                    When the events set to Roll-up are sent together, as one summary.
                  </div>
                </td>
                {dests.map((d) => (
                  <td key={d.id}>
                    <ScheduleCell d={d} onChange={(x) => replace(x)} />
                  </td>
                ))}
              </tr>
              <tr>
                <td className="fw-medium">Next roll-up</td>
                {dests.map((d) => (
                  <td key={d.id} className="small text-muted" data-testid={`next-${d.id}`}>
                    {hasRoll(d) ? (
                      <strong className="text-body">{fmtNext(nextRollup(d.rollup))}</strong>
                    ) : (
                      "Nothing set to Roll-up"
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </Table>
        </div>
      )}

      {anyRoll && (
        <Alert variant="warning" className="py-2 small" data-testid="rollup-notice">
          Roll-up summaries are not being sent yet. Until they are, an event set to Roll-up is held back and not
          delivered. Use Immediately for anything you must hear about.
        </Alert>
      )}

      {sel && (
        <section className="mt-3" data-testid="notification-preview">
          <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
            <h6 className="mb-0">What {sel.name} would receive</h6>
            <div className="d-flex flex-wrap gap-1" role="group" aria-label="Destination to preview">
              {dests.map((d) => (
                <Button
                  key={d.id}
                  size="sm"
                  variant={d.id === sel.id ? "primary" : "outline-secondary"}
                  className="rounded-pill"
                  aria-pressed={d.id === sel.id}
                  onClick={() => setSelected(d.id)}
                >
                  {d.name}
                </Button>
              ))}
            </div>
          </div>
          <div className="border rounded p-3 d-flex flex-column gap-2" style={{ maxWidth: "36rem" }}>
            <div className="text-muted small text-uppercase fw-semibold">Immediately, as each event happens</div>
            {(preview?.immediate || []).length === 0 ? (
              <p className="text-muted fst-italic mb-0">No event is set to Immediately.</p>
            ) : (
              preview.immediate.map((m) => <Bubble key={m.title + m.body} d={sel} m={m} />)
            )}
          </div>
          <p className="text-muted small mt-2">
            Only counts, source folders and times are sent. File names, error causes and paths stay on this Mac, in the
            Tasks page. Use your iPhone&apos;s Focus modes for quiet hours; a Focus can silence messages from yourself,
            so allow your own contact card in it.
          </p>
        </section>
      )}

      <section className="mt-3" data-testid="recent-messages">
        <h6>Recent messages</h6>
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th className="text-nowrap">When</th>
              <th>Destination</th>
              <th>Event</th>
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

function AddDestination({ onAdd }) {
  const [type, setType] = useState("imessage");

  return (
    <div className="d-flex gap-1">
      <Form.Select
        size="sm"
        aria-label="Destination type"
        value={type}
        onChange={(e) => setType(e.target.value)}
        style={{ width: "auto" }}
      >
        {Object.entries(TYPES).map(([id, t]) => (
          <option key={id} value={id}>
            {t.label}
          </option>
        ))}
      </Form.Select>
      <Button size="sm" variant="outline-primary" onClick={() => onAdd(type)}>
        + Add destination
      </Button>
    </div>
  );
}
