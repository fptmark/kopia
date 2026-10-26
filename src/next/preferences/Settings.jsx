import React, { use } from "react";
import Form from "react-bootstrap/Form";
import { PAGE_SIZES, UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { DATE_FORMATS } from "../format";
import { Field, FormSection, SwitchField, VerifyModePicker } from "../ui";

/** How the pages look, how the Mac behaves while backing up, and how much checking each snapshot gets. */
export function Settings() {
  const {
    theme,
    fontSize,
    bytesStringBase2,
    pageSize,
    keepAwake,
    dateFormat,
    verifyNewData,
    verifyEachMode,
    verifyEachPercent,
    setTheme,
    setFontSize,
    setByteStringBase,
    setPageSize,
    setKeepAwake,
    setDateFormat,
    setVerifyNewData,
    setVerifyEach,
  } = use(UIPreferencesContext);

  return (
    <>
      <FormSection title="Appearance">
        <div className="row">
          <div className="col-md-6 col-lg-3">
            <Field label="Theme">
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
            <Field label="Sizes are written in">
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
            <Field label="Rows per table page">
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
          <div className="col-md-6 col-lg-3">
            <Field label="Dates in tables" help="Tables only.">
              {(id) => (
                <Form.Select id={id} value={dateFormat || "medium"} onChange={(e) => setDateFormat(e.target.value)}>
                  {DATE_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
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
              help="Prevents sleep while a snapshot or check runs. Closing the lid on battery still sleeps."
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
          label="Verify every snapshot when it finishes"
          help="Failures show on History and in the health check."
          checked={verifyNewData}
          onChange={setVerifyNewData}
          data-testid="verify-new-data"
        />
        {verifyNewData && (
          <div className="ms-4" data-testid="verify-each">
            <VerifyModePicker
              name="verify-each"
              mode={verifyEachMode || "new"}
              percent={verifyEachPercent || 10}
              onChange={(m, p) => setVerifyEach(m, Number(p))}
            />
          </div>
        )}
      </FormSection>
    </>
  );
}
