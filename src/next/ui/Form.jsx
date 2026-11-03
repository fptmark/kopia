import React, { useEffect, useId, useState } from "react";
import Form from "react-bootstrap/Form";

/**
 * A labelled input: label above, help text and error below. children is the input, or a function that gets
 * the id to put on it so the label points at it.
 */
export function Field({ label, help, error, children, className = "" }) {
  const id = useId();
  const input = typeof children === "function" ? children(id) : children;

  return (
    <div className={"nx-field " + className}>
      {label && (
        <Form.Label htmlFor={typeof children === "function" ? id : undefined} className="form-label">
          {label}
        </Form.Label>
      )}
      {input}
      {help && <div className="nx-help">{help}</div>}
      {error && (
        <div className="text-danger small" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** A yes/no setting shown as a switch, with its explanation under it. */
export function SwitchField({ label, help, checked, onChange, disabled = false, ...rest }) {
  const id = useId();
  return (
    <div className="nx-field">
      <Form.Check
        type="switch"
        id={id}
        label={label}
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        {...rest}
      />
      {help && <div className="nx-help">{help}</div>}
    </div>
  );
}

/**
 * A number input with its own text buffer instead of reading straight from value: a plain controlled number
 * input snaps a mid-edit, momentarily-empty or leading-digit-deleted box back to the last committed number
 * before the next keystroke can land, which makes it look like it won't let you edit at all. onChange fires
 * with a parsed number as soon as the typed text is a valid one; min/max constrain what gets committed, not
 * what can be typed along the way (so e.g. deleting down to "" or "0" first doesn't fight you).
 */
export function NumberField({ value, onChange, min, max, ...rest }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const handleChange = (e) => {
    const raw = e.target.value;
    setText(raw);

    if (raw === "") {
      return;
    }

    const n = Number(raw);
    if (!Number.isNaN(n)) {
      onChange(n);
    }
  };

  return (
    <Form.Control type="number" value={text} onChange={handleChange} min={min} max={max} {...rest} />
  );
}

/** A titled group of fields, boxed with its title set into the top-left of the border (like a fieldset). */
export function FormSection({ title, children }) {
  return (
    <fieldset className="nx-form-section">
      {title && <legend>{title}</legend>}
      {children}
    </fieldset>
  );
}
