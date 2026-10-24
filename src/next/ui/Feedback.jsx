import React from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Spinner from "react-bootstrap/Spinner";

const VARIANTS = { success: "success", error: "danger", warning: "warning", info: "info" };

/** A message in a box: kind is success, error, warning or info. */
export function Notice({ kind = "info", title, children, onClose, ...rest }) {
  return (
    <Alert
      className="nx-notice"
      variant={VARIANTS[kind] ?? "info"}
      dismissible={!!onClose}
      onClose={onClose}
      role={kind === "error" ? "alert" : "status"}
      {...rest}
    >
      {title && <strong>{title} </strong>}
      {children}
    </Alert>
  );
}

export function Loading({ label = "Loading" }) {
  return (
    <div className="nx-loading" role="status" aria-label={label}>
      <Spinner animation="border" variant="primary" />
    </div>
  );
}

export function EmptyState({ children, ...rest }) {
  return (
    <div className="nx-empty" {...rest}>
      {children}
    </div>
  );
}

/** What a page shows when its data could not be loaded: the reason and a Try again button. */
export function ErrorState({ error, onRetry }) {
  return (
    <Notice kind="error" title="Could not load.">
      {error}{" "}
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Notice>
  );
}

/** Loading, error or the page, from the result of useLoad. */
export function Loaded({ state, children }) {
  if (state.error && state.data === undefined) {
    return <ErrorState error={state.error} onRetry={state.reload} />;
  }
  if (state.data === undefined) {
    return <Loading />;
  }
  return children(state.data);
}
