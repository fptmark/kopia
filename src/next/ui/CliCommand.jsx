import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import InputGroup from "react-bootstrap/InputGroup";
import { api } from "../api";

/** The command line that does what the page does, shown on request: "Command line" opens it. */
export function CliCommand({ command }) {
  const [open, setOpen] = useState(false);
  const [exe, setExe] = useState("");

  const toggle = () => {
    if (!open && !exe) {
      api
        .get("/api/v1/cli")
        .then((r) => setExe(r.data.executable || "kopia"))
        .catch(() => setExe("kopia"));
    }
    setOpen(!open);
  };

  const text = `${exe} ${command}`.trim();

  return (
    <div className="nx-small" data-testid="cli-command">
      <Button size="sm" variant="secondary" onClick={toggle} aria-expanded={open}>
        Command line
      </Button>
      {open && (
        <InputGroup size="sm" className="mt-2">
          <Form.Control readOnly aria-label="Command" value={text} className="nx-path" />
          <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}>
            Copy
          </Button>
        </InputGroup>
      )}
    </div>
  );
}
