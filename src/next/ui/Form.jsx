import React, { useId } from "react";
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

/** A titled group of fields. */
export function FormSection({ title, children }) {
  return (
    <section className="nx-form-section">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}
