import React, { use } from "react";
import Form from "react-bootstrap/Form";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { Field } from "../ui";

export function Scheduling() {
  const { keepAwake, setKeepAwake } = use(UIPreferencesContext);

  return (
    <div className="row">
      <div className="col-lg-8">
        <Field
          label="Keep the Mac awake during snapshots"
          help="Uses macOS caffeinate for the length of each snapshot, scheduled or manual. Closing the lid still sleeps the Mac. Applies to snapshots started after the change."
        >
          {(id) => (
            <Form.Select id={id} value={keepAwake || "never"} onChange={(e) => setKeepAwake(e.target.value)}>
              <option value="never">Never (the system may sleep and interrupt a snapshot)</option>
              <option value="idle">Yes, on any power source (prevents idle sleep)</option>
              <option value="ac">Yes, only on AC power (prevents idle and system sleep)</option>
            </Form.Select>
          )}
        </Field>
      </div>
    </div>
  );
}
