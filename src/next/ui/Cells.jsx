import React from "react";
import { compactCount, formatAgo, formatDateTime, sizeDisplayName } from "../format";
import { use } from "react";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";

/** One kind of status with one color, everywhere: added, removed, modified, ok, warning, error, running, info, neutral. */
export function StatusBadge({ kind = "neutral", children, ...rest }) {
  return (
    <span className={"nx-badge " + kind} {...rest}>
      {children ?? kind}
    </span>
  );
}

/** A byte size in the unit base the user picked in Preferences. */
export function SizeText({ bytes, ...rest }) {
  const { bytesStringBase2 } = use(UIPreferencesContext);
  if (bytes === undefined || bytes === null) {
    return <span className="nx-muted">{"—"}</span>;
  }
  return (
    <span className="nx-num" title={Number(bytes).toLocaleString("en-US") + " bytes"} {...rest}>
      {sizeDisplayName(bytes, !!bytesStringBase2)}
    </span>
  );
}

/** A count as 1.3M, with the whole number on hover. */
export function CountText({ n, ...rest }) {
  if (n === undefined || n === null) {
    return <span className="nx-muted">{"—"}</span>;
  }
  return (
    <span className="nx-num" title={Number(n).toLocaleString("en-US")} {...rest}>
      {compactCount(n)}
    </span>
  );
}

/** A date and time; ago shows "3 h ago" instead, with the date on hover. */
export function DateTimeText({ value, ago = false, ...rest }) {
  if (!value) {
    return <span className="nx-muted">{"—"}</span>;
  }
  return (
    <span className="nx-num" title={ago ? formatDateTime(value) : undefined} {...rest}>
      {ago ? formatAgo(value) : formatDateTime(value)}
    </span>
  );
}

/** A file path or pattern, in the code font. */
export function PathText({ children, dir = false, ...rest }) {
  return (
    <span className="nx-path" {...rest}>
      {children}
      {dir ? "/" : ""}
    </span>
  );
}
