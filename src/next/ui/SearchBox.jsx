import React from "react";
import Form from "react-bootstrap/Form";

/** The text filter that goes in a toolbar group. */
export function SearchBox({ value, onChange, placeholder = "Filter", label = "Filter", ...rest }) {
  return (
    <Form.Control
      type="search"
      size="sm"
      className="nx-search"
      placeholder={placeholder}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}
