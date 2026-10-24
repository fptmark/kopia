import React from "react";

/** A bordered box with an optional title row. flush removes the padding (for a table inside). */
export function Panel({ title, note, actions, flush = false, children, className = "", ...rest }) {
  return (
    <section className={"nx-panel " + className} {...rest}>
      {(title || actions) && (
        <header className="nx-panel-head">
          {title && <h2 className="nx-panel-title">{title}</h2>}
          {note && <span className="nx-panel-note">{note}</span>}
          {actions && <div className="nx-panel-actions">{actions}</div>}
        </header>
      )}
      <div className={"nx-panel-body" + (flush ? " flush" : "")}>{children}</div>
    </section>
  );
}

/** A row of figures: <Stats><Stat label="Before" value="Oct 23" note="204 GB" /></Stats>. */
export function Stats({ children, ...rest }) {
  return (
    <div className="nx-stats" {...rest}>
      {children}
    </div>
  );
}

export function Stat({ label, value, note }) {
  return (
    <div>
      <div className="nx-stat-label">{label}</div>
      <div className="nx-stat-value">{value}</div>
      {note && <div className="nx-stat-note">{note}</div>}
    </div>
  );
}
