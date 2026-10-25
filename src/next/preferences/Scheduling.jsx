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
          label="Keep the Mac awake during snapshots and checks"
          help="Uses macOS caffeinate while a snapshot, verify or health check runs, so a sleeping Mac does not drop the NAS connection. Closing the lid on battery still sleeps the Mac."
        >
          {(id) => (
            <Form.Select id={id} value={keepAwake === "ac" ? "ac" : "idle"} onChange={(e) => setKeepAwake(e.target.value)}>
              <option value="idle">Prevent idle sleep (any power source)</option>
              <option value="ac">Also prevent lid-close sleep on AC power</option>
            </Form.Select>
          )}
        </Field>
      </div>
    </div>
  );
}
