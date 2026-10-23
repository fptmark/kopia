import axios from "axios";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { sourceQueryStringParams } from "../utils/policyutil";
import { DurationInput } from "./DurationInput";

// the global policy: where the default snapshot frequency lives
const POLICY_URL = "/api/v1/policy?" + sourceQueryStringParams({ userName: "", host: "", path: "" });

const MIN_SECONDS = 60;
const MAX_SECONDS = 365 * 86400;

const errorText = (e) => e?.response?.data?.message || e?.message || "unknown error";

/**
 * "Snapshot every [ N ] [sec|min|hr|days]": the frequency in the global policy, which every source without a
 * schedule of its own follows. sources are the rows of the page, to notice ones that have their own.
 */
export function SnapshotFrequency({ sources = [], onSaved = () => {} }) {
  const [saved, setSaved] = useState(null); // seconds in the global policy (0 for none), null until known
  const [status, setStatus] = useState({ kind: "", text: "" });

  useEffect(() => {
    axios
      .get(POLICY_URL)
      .then((r) => setSaved(r.data?.scheduling?.intervalSeconds || 0))
      .catch(() => setSaved(0)); // no global policy yet; saving creates it
  }, []);

  const save = (seconds) =>
    // read the policy again so nothing else in it is overwritten
    axios
      .get(POLICY_URL)
      .catch(() => ({ data: {} }))
      .then((r) => {
        const policy = r.data || {};
        const scheduling = { ...policy.scheduling };
        if (seconds) {
          scheduling.intervalSeconds = seconds;
        } else {
          delete scheduling.intervalSeconds;
        }
        policy.scheduling = scheduling;
        return axios.put(POLICY_URL, policy);
      })
      .then(() => {
        setSaved(seconds || 0);
        setStatus({ kind: "ok", text: "Saved." });
        onSaved();
      })
      .catch((e) => setStatus({ kind: "error", text: "Not saved: " + errorText(e) }));

  const own = saved !== null && sources.some((s) => (s.schedule?.intervalSeconds || 0) !== saved);

  return (
    <div className="d-flex flex-wrap align-items-center gap-1 small" data-testid="snapshot-frequency">
      Snapshot every
      <DurationInput
        ariaLabel="Snapshot frequency"
        seconds={saved || undefined}
        allowEmpty
        minSeconds={MIN_SECONDS}
        maxSeconds={MAX_SECONDS}
        invalidMessage="Enter a number and a unit: at least 1 minute, at most 365 days."
        onCommit={(s) => {
          setStatus({ kind: "", text: "" });
          return save(s);
        }}
      />
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
