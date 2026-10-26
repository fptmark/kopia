import React, { use } from "react";
import { PagerSlotContext } from "./PagerSlot";

/**
 * The row above a table. Related controls go in one Group, which is drawn as a bordered box with a small
 * label, so what belongs together reads as together. end pushes a group to the right; grow lets it take the
 * free width.
 */
export function Toolbar({ children, ...rest }) {
  const pager = use(PagerSlotContext);
  return (
    <div className="nx-toolbar" {...rest}>
      {children}
      <span className="nx-pager-slot" ref={pager?.setSlot} />
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
