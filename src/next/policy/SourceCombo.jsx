import React, { useRef, useState } from "react";
import Form from "react-bootstrap/Form";
import { includesText } from "../format";
import { ownerName } from "../snapshots";

/**
 * A combo box over the sources you already have: type to filter, click a match to pick it. There is no free
 * text -- nothing happens unless you click (or keyboard-select) an actual source.
 */
export function SourceCombo({ sources, value, onPick, placeholder = "Search your sources…" }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const matches = sources.filter((s) => includesText(s.path, filter) || includesText(ownerName(s), filter));

  const pick = (s) => {
    setFilter("");
    setOpen(false);
    onPick(s);
  };

  const onBlurCapture = (e) => {
    if (!wrapRef.current?.contains(e.relatedTarget)) {
      setOpen(false);
    }
  };

  return (
    <div className="nx-combo" ref={wrapRef} onBlurCapture={onBlurCapture}>
      <Form.Control
        size="sm"
        className="nx-search"
        aria-label="Source"
        placeholder={placeholder}
        value={open ? filter : value || ""}
        onFocus={() => {
          setFilter("");
          setOpen(true);
        }}
        onChange={(e) => {
          setFilter(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      {open && (
        <div className="nx-combo-menu" role="listbox" aria-label="Sources">
          {matches.length === 0 && <div className="nx-combo-empty">No sources match.</div>}
          {matches.map((s) => (
            <div
              key={ownerName(s) + ":" + s.path}
              role="option"
              aria-selected={s.path === value}
              tabIndex={0}
              className="nx-combo-opt"
              onClick={() => pick(s)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick(s)}
            >
              <span className="nx-path">{s.path}</span>
              <span className="nx-muted small">{ownerName(s)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
