import React, { useCallback, useEffect, useRef, useState } from "react";
import Button from "react-bootstrap/Button";
import Dropdown from "react-bootstrap/Dropdown";
import Form from "react-bootstrap/Form";
import { DurationInput } from "../../components/DurationInput";
import { WhenField } from "../../components/WhenField";
import { errorMessage } from "../api";
import { useLoad } from "../hooks";
import {
  DEFAULT_SUCCESS,
  EVENT_NAME,
  failuresLabel,
  FAILURES,
  isScheduled,
  loadDestinations,
  loadMailAccounts,
  loadNotificationLog,
  MAX_REPEAT_SECONDS,
  MIN_REPEAT_SECONDS,
  newDestination,
  saveDestinations,
  SUCCESS,
  testDestination,
  TYPES,
} from "../notifications";
import { ConfirmDialog, DataTable, DateTimeText, Loaded, Panel, StatusBadge } from "../ui";

/** A drop-down of check boxes: which failures this destination is told about. */
function FailuresPicker({ d, onChange }) {
  const has = (id) => d.failures?.includes(id);
  const toggle = (id) => onChange(has(id) ? d.failures.filter((x) => x !== id) : [...(d.failures || []), id]);
  // failure types this page does not list are kept as they are
  const others = (d.failures || []).filter((id) => !FAILURES.some((f) => f.id === id));

  return (
    <Dropdown autoClose="outside">
      <Dropdown.Toggle size="sm" variant="secondary" className="w-100 text-start" aria-label={`Failures for ${d.name}`}>
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
        <div className="d-flex gap-2 mt-2">
          <Button size="sm" variant="secondary" onClick={() => onChange([...FAILURES.map((f) => f.id), ...others])}>
            All
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onChange(others)}>
            None
          </Button>
        </div>
      </Dropdown.Menu>
    </Dropdown>
  );
}

function WhenCell({ d, onChange }) {
  const s = d.success || DEFAULT_SUCCESS;
  if (!isScheduled(d)) {
    return <span className="nx-muted">{"—"}</span>;
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

function RecentMessages({ dests }) {
  const log = useLoad(loadNotificationLog, [], { refreshMs: 30000 });
  const nameOf = (id) => dests.find((d) => d.id === id)?.name || id;

  return (
    <Panel title="Recent messages" flush data-testid="recent-messages">
      <DataTable
        label="recent messages"
        data={log.data ?? []}
        getRowId={(l) => `${l.sentAt}-${l.destination}-${l.event}`}
        footer={false}
        emptyText="Nothing has been sent yet."
        columns={[
          { id: "when", header: "When", cell: (l) => <DateTimeText value={l.sentAt} /> },
          { id: "to", header: "Destination", cell: (l) => nameOf(l.destination) },
          { id: "what", header: "Message", cell: (l) => EVENT_NAME[l.event] || l.event },
          {
            id: "result",
            header: "Result",
            cell: (l) =>
              l.status === "sent" ? (
                <StatusBadge kind="ok">Sent</StatusBadge>
              ) : (
                <>
                  <StatusBadge kind="error">Failed</StatusBadge> <span className="small text-break">{l.error}</span>
                </>
              ),
          },
          {
            id: "tries",
            header: "",
            cell: (l) => (l.attempts > 1 ? <span className="nx-muted small">{l.attempts} tries</span> : ""),
          },
        ]}
      />
    </Panel>
  );
}

/** Where backup alerts go: one row per destination, then the recent messages. */
export function Notifications() {
  const state = useLoad(loadDestinations, []);
  const [dests, setDests] = useState(null);
  const [repeat, setRepeat] = useState(null);
  const [status, setStatus] = useState({ kind: "", text: "" });
  const [mail, setMail] = useState([]);
  const [removing, setRemoving] = useState(null);
  const latestRef = useRef([]);
  const repeatRef = useRef(0);
  const seqRef = useRef(0);

  // the saved list seeds what is edited here; edits are shown at once and saved in the background
  useEffect(() => {
    if (state.data) {
      latestRef.current = state.data.destinations;
      repeatRef.current = state.data.repeatSeconds;
      setDests(state.data.destinations);
      setRepeat(state.data.repeatSeconds);
    }
  }, [state.data]);

  const hasEmail = !!dests?.some((d) => d.type === "email");
  useEffect(() => {
    if (hasEmail) {
      loadMailAccounts()
        .then(setMail)
        .catch((e) => setStatus({ kind: "error", text: "Unable to read the accounts in Mail: " + errorMessage(e) }));
    }
  }, [hasEmail]);

  const persist = useCallback((list) => {
    const n = ++seqRef.current;
    return saveDestinations(repeatRef.current, list).then(
      () => n === seqRef.current && setStatus({ kind: "ok", text: "Saved." }),
      (e) => n === seqRef.current && setStatus({ kind: "error", text: "Not saved: " + errorMessage(e) }),
    );
  }, []);

  // text fields are saved when left, not on every keystroke
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

  const test = (d) => {
    setStatus({ kind: "", text: `Sending a test message to ${d.name}...` });
    return testDestination(d.id).then(
      () => setStatus({ kind: "ok", text: `Test message sent to ${d.name}.` }),
      (e) => setStatus({ kind: "error", text: `Test to ${d.name} failed: ${errorMessage(e)}` }),
    );
  };

  const fromChoices = mail.flatMap((a) => a.addresses.map((address) => ({ address, label: `${a.name} (${address})` })));

  return (
    <Loaded state={state}>
      {() =>
        !dests ? null : (
          <>
            <Panel
              title="Destinations"
              flush
              data-testid="notification-destinations"
              actions={
                <>
                  {status.text && (
                    <span className={"small " + (status.kind === "error" ? "text-danger" : "nx-muted")} role="status">
                      {status.text}
                    </span>
                  )}
                  <Dropdown align="end">
                    <Dropdown.Toggle variant="primary" size="sm">
                      Add destination
                    </Dropdown.Toggle>
                    <Dropdown.Menu>
                      {Object.entries(TYPES).map(([type, t]) => (
                        <Dropdown.Item key={type} onClick={() => change([...latestRef.current, newDestination(type)])}>
                          {t.menu}
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown>
                </>
              }
            >
              <DataTable
                label="destinations"
                data={dests}
                getRowId={(d) => d.id}
                footer={false}
                emptyText="No destinations."
                columns={[
                  {
                    id: "name",
                    header: "Destination",
                    cell: (d) => (
                      <Form.Control
                        size="sm"
                        className="fw-semibold"
                        aria-label={`Name of ${d.name}`}
                        value={d.name}
                        onChange={(e) => replace({ ...d, name: e.target.value }, false)}
                        onBlur={() => persist(latestRef.current)}
                      />
                    ),
                  },
                  {
                    id: "address",
                    header: "Address",
                    cell: (d) => (
                      <>
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
                      </>
                    ),
                  },
                  {
                    id: "failures",
                    header: "Failures (sent at once)",
                    cell: (d) => <FailuresPicker d={d} onChange={(failures) => replace({ ...d, failures })} />,
                  },
                  {
                    id: "success",
                    header: "Success",
                    cell: (d) => (
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
                    ),
                  },
                  { id: "when", header: "When", cell: (d) => <WhenCell d={d} onChange={(x) => replace(x)} /> },
                  {
                    id: "actions",
                    header: "",
                    align: "end",
                    cell: (d) => (
                      <span className="d-inline-flex gap-1">
                        <Button size="sm" variant="secondary" onClick={() => test(d)} aria-label={`Test ${d.name}`}>
                          Test
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setRemoving(d)}
                          aria-label={`Delete ${d.name}`}
                        >
                          Delete
                        </Button>
                      </span>
                    ),
                  },
                ]}
              />
            </Panel>

            <div className="nx-muted small d-flex align-items-center gap-1 flex-wrap">
              Repeated failures are sent once every
              <DurationInput
                ariaLabel="Repeat period"
                seconds={repeat}
                minSeconds={MIN_REPEAT_SECONDS}
                maxSeconds={MAX_REPEAT_SECONDS}
                invalidMessage="Enter a number and a unit, from 1 min to 30 days."
                onCommit={(s) => {
                  repeatRef.current = s;
                  setRepeat(s);
                  persist(latestRef.current);
                }}
              />
              per destination.
            </div>

            <RecentMessages dests={dests} />

            <ConfirmDialog
              show={!!removing}
              title="Delete this destination?"
              confirmLabel="Delete"
              danger
              onCancel={() => setRemoving(null)}
              onConfirm={() => {
                change(latestRef.current.filter((x) => x.id !== removing.id));
                setRemoving(null);
              }}
            >
              {removing && <>"{removing.name}" stops receiving alerts.</>}
            </ConfirmDialog>
          </>
        )
      }
    </Loaded>
  );
}
