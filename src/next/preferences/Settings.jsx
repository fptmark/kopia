import React from "react";
import Form from "react-bootstrap/Form";
import { PAGE_SIZES } from "../../contexts/UIPreferencesContext";
import { DATE_FORMATS } from "../format";
import { Field, FormSection, NumberField, Panel, SwitchField, VerifyModePicker } from "../ui";

/**
 * How the pages look, how the Mac behaves while backing up, and how much checking each snapshot gets.
 * draft/change come from useSettingsDraft -- nothing here reaches the server until the page's Save is
 * clicked.
 */
export function Settings({ draft, change }) {
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
    storageStallTimeoutSeconds,
    wakeGraceMinutes,
    retryTierThresholdHours,
    oftenRetryCount,
    oftenRetryIntervalMinutes,
    occasionalRetryCount,
    occasionalRetryIntervalMinutes,
  } = draft;

  return (
    <Panel className="nx-panel-plain">
      <FormSection title="Appearance">
        <div className="row">
          <div className="col-md-6 col-lg-3">
            <Field label="Theme">
              {(id) => (
                <Form.Select id={id} value={theme} onChange={(e) => change({ theme: e.target.value })}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </Form.Select>
              )}
            </Field>
          </div>
          <div className="col-md-6 col-lg-3">
            <Field label="Text size">
              {(id) => (
                <Form.Select id={id} value={fontSize} onChange={(e) => change({ fontSize: e.target.value })}>
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
                  value={String(bytesStringBase2)}
                  onChange={(e) => change({ bytesStringBase2: e.target.value === "true" })}
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
                <Form.Select id={id} value={pageSize} onChange={(e) => change({ pageSize: Number(e.target.value) })}>
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
                <Form.Select id={id} value={dateFormat} onChange={(e) => change({ dateFormat: e.target.value })}>
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
                <Form.Select id={id} value={keepAwake} onChange={(e) => change({ keepAwake: e.target.value })}>
                  <option value="idle">Prevent idle sleep (any power source)</option>
                  <option value="ac">Also prevent lid-close sleep on AC power</option>
                </Form.Select>
              )}
            </Field>
          </div>
          <div className="col-lg-8">
            <Field
              label="Treat a snapshot as stale for this long after waking from sleep"
              help="A real wake can leave the latest snapshot briefly looking overdue before scheduling has caught up. The health check waits this long after a start or a wake before flagging it."
            >
              {(id) => (
                <div className="nx-row">
                  <NumberField
                    id={id}
                    size="sm"
                    min={1}
                    max={60}
                    style={{ width: "6rem" }}
                    value={wakeGraceMinutes}
                    onChange={(n) => change({ wakeGraceMinutes: n })}
                  />
                  <span>minutes</span>
                </div>
              )}
            </Field>
          </div>
        </div>
      </FormSection>
      <FormSection title="Storage connection">
        <div className="row">
          <div className="col-lg-8">
            <Field
              label="Quit a task if storage stops responding for"
              help="Applies to Snapshot, Verify and Maintenance tasks. A listing, read or write that goes this long with no response (an unreachable NAS, for example) ends the task instead of it sitting unresponsive."
            >
              {(id) => (
                <div className="nx-row">
                  <NumberField
                    id={id}
                    size="sm"
                    min={5}
                    max={600}
                    style={{ width: "6rem" }}
                    value={storageStallTimeoutSeconds}
                    onChange={(n) => change({ storageStallTimeoutSeconds: n })}
                  />
                  <span>seconds</span>
                </div>
              )}
            </Field>
          </div>
        </div>
      </FormSection>
      <FormSection title="Automatic retries">
        <div className="row">
          <div className="col-lg-8">
            <Field
              label={'A source is "often" scheduled if its own runs are this close together'}
              help="Applies to Snapshot and Verify. A source whose own schedule is within this many hours gets a short retry burst on failure; a less frequent source gets a longer one, and also won't start a fresh automatic run sooner than this many hours after its last one completed."
            >
              {(id) => (
                <div className="nx-row">
                  <NumberField
                    id={id}
                    size="sm"
                    min={1}
                    max={24}
                    style={{ width: "6rem" }}
                    value={retryTierThresholdHours}
                    onChange={(n) => change({ retryTierThresholdHours: n })}
                  />
                  <span>hours</span>
                </div>
              )}
            </Field>
          </div>
        </div>
        <div className="row">
          <div className="col-lg-8">
            <Field
              label="Often: retry this many times, this far apart"
              help="Every failed automatic attempt gets this burst first, regardless of tier."
            >
              {(id) => (
                <div className="nx-row">
                  <NumberField
                    id={id}
                    size="sm"
                    min={0}
                    max={20}
                    style={{ width: "5rem" }}
                    value={oftenRetryCount}
                    onChange={(n) => change({ oftenRetryCount: n })}
                  />
                  <span>times,</span>
                  <NumberField
                    id={`${id}-interval`}
                    size="sm"
                    min={1}
                    max={60}
                    style={{ width: "5rem" }}
                    value={oftenRetryIntervalMinutes}
                    onChange={(n) => change({ oftenRetryIntervalMinutes: n })}
                  />
                  <span>minutes apart</span>
                </div>
              )}
            </Field>
          </div>
        </div>
        <div className="row">
          <div className="col-lg-8">
            <Field
              label="Occasional: then escalate to this many more, this far apart"
              help="Only for a source whose own schedule is less frequent than the threshold above, once the often burst is also exhausted."
            >
              {(id) => (
                <div className="nx-row">
                  <NumberField
                    id={id}
                    size="sm"
                    min={0}
                    max={20}
                    style={{ width: "5rem" }}
                    value={occasionalRetryCount}
                    onChange={(n) => change({ occasionalRetryCount: n })}
                  />
                  <span>times,</span>
                  <NumberField
                    id={`${id}-interval`}
                    size="sm"
                    min={1}
                    max={120}
                    style={{ width: "5rem" }}
                    value={occasionalRetryIntervalMinutes}
                    onChange={(n) => change({ occasionalRetryIntervalMinutes: n })}
                  />
                  <span>minutes apart</span>
                </div>
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
          onChange={(v) => change({ verifyNewData: v })}
          data-testid="verify-new-data"
        />
        {verifyNewData && (
          <div data-testid="verify-each">
            <VerifyModePicker
              name="verify-each"
              mode={verifyEachMode}
              percent={verifyEachPercent}
              onChange={(m, p) => change({ verifyEachMode: m, verifyEachPercent: Number(p) })}
            />
          </div>
        )}
      </FormSection>
    </Panel>
  );
}
