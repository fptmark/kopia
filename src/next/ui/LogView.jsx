import React, { useEffect, useRef } from "react";

function time(ts) {
  const d = new Date(ts * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function extras(entry) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { msg, ts, level, mod, ...rest } = entry;
  const json = JSON.stringify(rest);
  return json === "{}" ? "" : json;
}

const LEVEL_CLASS = { error: "text-danger", warn: "text-warning", warning: "text-warning", debug: "nx-muted" };

/** Log lines of a task, newest at the bottom; the view follows new lines as they arrive. */
export function LogView({ logs, maxHeight = "28rem" }) {
  const endRef = useRef(null);
  const last = logs.length ? logs[logs.length - 1].ts + logs[logs.length - 1].msg : "";

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [last]);

  if (logs.length === 0) {
    return <div className="nx-empty">No log lines yet.</div>;
  }

  return (
    <div className="nx-log" style={{ maxHeight }} data-testid="log-view">
      {logs.map((l, i) => (
        <div
          key={i + ":" + l.ts}
          className={"nx-log-line " + (LEVEL_CLASS[l.level] ?? "")}
          title={new Date(l.ts * 1000).toLocaleString()}
        >
          <span className="nx-muted">{time(l.ts)}</span> {l.msg} {extras(l) && <code>{extras(l)}</code>}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
