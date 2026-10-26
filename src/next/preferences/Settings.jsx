import React, { use } from "react";
import Form from "react-bootstrap/Form";
import { PAGE_SIZES, UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { Field, FormSection, SwitchField } from "../ui";

/** How the pages look, how the Mac behaves while backing up, and how much checking each snapshot gets. */
export function Settings() {
  const {
    theme,
    fontSize,
    bytesStringBase2,
    pageSize,
    keepAwake,
    verifyNewData,
    setTheme,
    setFontSize,
    setByteStringBase,
    setPageSize,
    setKeepAwake,
    setVerifyNewData,
  } = use(UIPreferencesContext);

  return (
    <>
      <FormSection title="Appearance">
        <div className="row">
          <div className="col-md-6 col-lg-3">
            <Field label="Theme" help="Pastel and ocean, from the old UI, show as light.">
              {(id) => (
                <Form.Select
                  id={id}
                  value={theme === "dark" ? "dark" : "light"}
                  onChange={(e) => setTheme(e.target.value)}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </Form.Select>
              )}
            </Field>
          </div>
          <div className="col-md-6 col-lg-3">
            <Field label="Text size">
              {(id) => (
                <Form.Select id={id} value={fontSize} onChange={(e) => setFontSize(e.target.value)}>
                  <option value="fs-6">Small</option>
                  <option value="fs-5">Medium</option>
                  <option value="fs-4">Large</option>
                </Form.Select>
              )}
            </Field>
          </div>
          <div className="col-md-6 col-lg-3">
            <Field label="Sizes are written in" help="Base 10 is what Finder and disk makers use.">
              {(id) => (
                <Form.Select
                  id={id}
                  value={String(!!bytesStringBase2)}
                  onChange={(e) => setByteStringBase(e.target.value)}
                >
                  <option value="false">Base 10 (KB, MB, GB, TB)</option>
                  <option value="true">Base 2 (KiB, MiB, GiB, TiB)</option>
                </Form.Select>
              )}
            </Field>
          </div>
          <div className="col-md-6 col-lg-3">
            <Field label="Rows per table page" help="Each table can also be changed on its own page.">
              {(id) => (
                <Form.Select id={id} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Form.Select>
              )}
            </Field>
          </div>
        </div>
      </FormSection>
      <FormSection title="Power">
        <div className="row">
          <div className="col-lg-8">
            <Field
              label="Keep the Mac awake during snapshots and checks"
              help="Uses macOS caffeinate while a snapshot, verify or health check runs, so a sleeping Mac does not drop the NAS connection. Closing the lid on battery still sleeps the Mac."
            >
              {(id) => (
                <Form.Select
                  id={id}
                  value={keepAwake === "ac" ? "ac" : "idle"}
                  onChange={(e) => setKeepAwake(e.target.value)}
                >
                  <option value="idle">Prevent idle sleep (any power source)</option>
                  <option value="ac">Also prevent lid-close sleep on AC power</option>
                </Form.Select>
              )}
            </Field>
          </div>
        </div>
      </FormSection>
      <FormSection title="Verification">
        <SwitchField
          label="Read back the data each snapshot adds"
          help="Right after every snapshot, reads back everything it wrote to the repository from the NAS and checks it. Quick, because most of a snapshot is data that was already stored. The result shows in the Verified column on the History page, and a failure fails the health check for a day. Applies to snapshots that finish after the change. The daily health check also samples each source's newest snapshot."
          checked={verifyNewData}
          onChange={setVerifyNewData}
          data-testid="verify-new-data"
        />
      </FormSection>
    </>
  );
}
