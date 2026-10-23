import axios from "axios";
import { useEffect, useRef, useState } from "react";
import Form from "react-bootstrap/Form";
import { Link } from "react-router";
import { sourceQueryStringParams } from "../utils/policyutil";

// the global policy: where the default snapshot frequency lives
const POLICY_URL = "/api/v1/policy?" + sourceQueryStringParams({ userName: "", host: "", path: "" });

const UNIT_SECONDS = { hours: 3600, days: 86400 };
const MIN_SECONDS = 600; // every 10 minutes
const MAX_SECONDS = 365 * 86400;

/** The number and unit that show an interval: whole days as days, anything else in (possibly fractional) hours. */
export function splitInterval(seconds) {
  if (!seconds) {
    return { text: "", unit: "hours" };
  }
  if (seconds % 86400 === 0) {
    return { text: String(seconds / 86400), unit: "days" };
  }
  return { text: String(Math.round((seconds / 3600) * 100) / 100), unit: "hours" };
}

/** The interval in seconds for a typed number and unit, or null when it is not a usable interval. */
export function intervalSeconds(text, unit) {
  if (!/^\d*\.?\d+$/.test(text.trim())) {
    return null;
  }
  const s = Math.round(Number(text) * UNIT_SECONDS[unit]);
  return s >= MIN_SECONDS && s <= MAX_SECONDS ? s : null;
}

const errorText = (e) => e?.response?.data?.message || e?.message || "unknown error";

/**
 * "Snapshot every [ N ] [hours|days]": the frequency in the global policy, which every source without a
 * schedule of its own follows. sources are the rows of the page, to notice ones that have their own.
 */
export function SnapshotFrequency({ sources = [], onSaved = () => {} }) {
  const [saved, setSaved] = useState(null); // seconds in the global policy, null until known
  const [text, setText] = useState("");
  const [unit, setUnit] = useState("hours");
  const [status, setStatus] = useState({ kind: "", text: "" });
  const textRef = useRef("");
  const unitRef = useRef("hours");

  useEffect(() => {
    axios
      .get(POLICY_URL)
      .then((r) => {
        const s = r.data?.scheduling?.intervalSeconds || 0;
        const v = splitInterval(s);
        setSaved(s);
        setText(v.text);
        setUnit(v.unit);
        textRef.current = v.text;
        unitRef.current = v.unit;
      })
      .catch(() => {
        setSaved(0); // no global policy yet; saving creates it
      });
  }, []);

  const save = (nextText, nextUnit) => {
    const seconds = intervalSeconds(nextText, nextUnit);
    if (seconds === null) {
      setStatus({ kind: "error", text: "Enter a number of hours or days, from 10 minutes to 365 days." });
      const v = splitInterval(saved);
      setText(v.text);
      setUnit(v.unit);
      textRef.current = v.text;
      unitRef.current = v.unit;
      return Promise.resolve();
    }
    if (seconds === saved) {
      return Promise.resolve();
    }

    // read the policy again so nothing else in it is overwritten
    return axios
      .get(POLICY_URL)
      .catch(() => ({ data: {} }))
      .then((r) => {
        const policy = r.data || {};
        policy.scheduling = { ...policy.scheduling, intervalSeconds: seconds };
        return axios.put(POLICY_URL, policy);
      })
      .then(() => {
        setSaved(seconds);
        setStatus({ kind: "ok", text: "Saved." });
        onSaved();
      })
      .catch((e) => setStatus({ kind: "error", text: "Not saved: " + errorText(e) }));
  };

  const own = saved !== null && sources.some((s) => (s.schedule?.intervalSeconds || 0) !== saved);

  return (
    <div className="d-flex flex-wrap align-items-center gap-1 small" data-testid="snapshot-frequency">
      Snapshot every
      <Form.Control
        size="sm"
        type="text"
        inputMode="decimal"
        aria-label="Snapshot frequency"
        placeholder="—"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          textRef.current = e.target.value;
        }}
        onBlur={() => save(textRef.current, unitRef.current)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        style={{ width: "4.5rem" }}
      />
      <Form.Select
        size="sm"
        aria-label="Snapshot frequency unit"
        value={unit}
        onChange={(e) => {
          setUnit(e.target.value);
          unitRef.current = e.target.value;
          save(textRef.current, e.target.value);
        }}
        style={{ width: "auto" }}
      >
        <option value="hours">hours</option>
        <option value="days">days</option>
      </Form.Select>
      {status.text && (
        <span className={status.kind === "error" ? "text-danger" : "text-muted"} role="status">
          {status.text}
        </span>
      )}
      {own && (
        <span className="text-muted">
          · some sources have their own schedule, see <Link to="/policies">Policies</Link>
        </span>
      )}
    </div>
  );
}
