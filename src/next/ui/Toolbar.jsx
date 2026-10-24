import React from "react";

/**
 * The row above a table. Related controls go in one Group, which is drawn as a bordered box with a small
 * label, so what belongs together reads as together. end pushes a group to the right; grow lets it take the
 * free width.
 */
export function Toolbar({ children, ...rest }) {
  return (
    <div className="nx-toolbar" {...rest}>
      {children}
    </div>
  );
}

function Group({ label, grow = false, end = false, children, ...rest }) {
  return (
    <div className={"nx-toolbar-group" + (grow ? " grow" : "") + (end ? " end" : "")} {...rest}>
      {label && <span className="nx-toolbar-label">{label}</span>}
      {children}
    </div>
  );
}

Toolbar.Group = Group;
