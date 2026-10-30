import React, { useState } from "react";
import Form from "react-bootstrap/Form";
import { Link } from "react-router";
import { DurationInput } from "../../components/DurationInput";
import { formatDuration } from "../../utils/duration";
import { formatDateTime } from "../format";
import { PathText, StatusBadge, TabNav } from "../ui";
import { SECTIONS, SECTION_GROUPS } from "./fields";
import { definedBy, getPath, hasValue, linesToText, textToLines, textToTimes, timesToText } from "./helpers";

/** What a setting is in effect, as text. */
function effectiveText(field, value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  switch (field.type) {
    case "bool":
    case "flag":
      return value ? "yes" : "no";
    case "lines":
      return value.join(", ");
    case "select":
      if (field.options === "compression") {
        return String(value);
      }
      return field.options.find((o) => String(o.value) === String(value))?.label ?? String(value);
    default:
      return String(value);
  }
}

function Control({ field, value, onChange, algorithms }) {
  const label = field.label;
  switch (field.type) {
    case "number":
      return (
        <Form.Control
          size="sm"
          type="number"
          min="0"
          aria-label={label}
          placeholder="inherit"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "verifyPercent":
      return (
        <Form.Control
          size="sm"
          type="number"
          min={1}
          max={100}
          aria-label={label}
          placeholder="inherit"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "bool":
      return (
        <Form.Select
          size="sm"
          aria-label={label}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}
        >
          <option value="">inherit</option>
          <option value="true">yes</option>
          <option value="false">no</option>
        </Form.Select>
      );
    case "flag":
      return (
        <Form.Check
          type="switch"
          aria-label={label}
          id={"flag-" + field.path}
          checked={!!value}
          onChange={(e) => onChange(e.target.checked || undefined)}
        />
      );
    case "select": {
      const options =
        field.options === "compression"
          ? [
              { value: "", label: "inherit" },
              ...(algorithms?.compression ?? []).map((a) => ({
                value: a.id,
                label: a.deprecated ? a.id + " (not recommended)" : a.id,
              })),
            ]
          : field.options;
      return (
        <Form.Select
          size="sm"
          aria-label={label}
          value={value === undefined ? "" : String(value)}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : field.numeric ? Number(e.target.value) : e.target.value)
          }
        >
          {options.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </Form.Select>
      );
    }
    case "lines":
      return (
        <Form.Control
          size="sm"
          as="textarea"
          rows={3}
          aria-label={label}
          value={linesToText(value)}
          onChange={(e) => onChange(textToLines(e.target.value))}
        />
      );
    case "text":
      return (
        <Form.Control
          size="sm"
          aria-label={label}
          placeholder="inherit"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      );
    default:
      return null;
  }
}

/** The percent a verifyPercent field shows: 100 when its mode is "full", its own raw percent otherwise. */
function verifyPercentOf(obj, field) {
  return getPath(obj, field.modePath) === "full" ? 100 : getPath(obj, field.path);
}

/** What a schedule field (interval or times of day, never both) reads as, in effect. */
function scheduleText(obj, field) {
  const interval = getPath(obj, field.path);
  if (interval) {
    return formatDuration(interval);
  }
  const times = getPath(obj, field.altPath);
  return times?.length ? timesToText(times).split("\n").join(", ") : "";
}

/**
 * One way to run a schedule, or the other: a repeating interval, or specific times of day. Picking one clears
 * the other's field so the two can never both be set and compete (scheduling_policy.go takes the earlier of
 * the two candidates each time it is due, which is confusing and -- for the interval side -- lands on UTC day
 * boundaries rather than local ones).
 */
function ScheduleControl({ field, policy, onChange }) {
  const interval = getPath(policy, field.path);
  const times = getPath(policy, field.altPath);
  const [mode, setMode] = useState(() => (interval ? "interval" : "times"));
  const name = "sched-" + field.path;

  return (
    <div className="nx-stack">
      <div>
        <Form.Check
          type="radio"
          id={name + "-times"}
          name={name}
          label="At specific times of day"
          checked={mode === "times"}
          onChange={() => {
            setMode("times");
            onChange(field.path, undefined);
          }}
        />
        {mode === "times" && (
          <Form.Control
            size="sm"
            as="textarea"
            rows={3}
            aria-label="Times of day"
            value={timesToText(times)}
            onChange={(e) => onChange(field.altPath, textToTimes(e.target.value))}
          />
        )}
      </div>
      <div>
        <Form.Check
          type="radio"
          id={name + "-interval"}
          name={name}
          label="On a repeating interval"
          checked={mode === "interval"}
          onChange={() => {
            setMode("interval");
            onChange(field.altPath, undefined);
          }}
        />
        {mode === "interval" && (
          <DurationInput
            ariaLabel="Interval"
            seconds={interval || undefined}
            allowEmpty
            minSeconds={60}
            maxSeconds={365 * 86400}
            invalidMessage="Enter a number and a unit: at least 1 minute, at most 365 days."
            onCommit={(v) => onChange(field.path, v)}
          />
        )}
      </div>
    </div>
  );
}

function Row({ field, policy, onChange, resolved, target, algorithms }) {
  const isVerifyPercent = field.type === "verifyPercent";
  const isSchedule = field.type === "schedule";
  const mine = isVerifyPercent ? verifyPercentOf(policy, field) : getPath(policy, field.path);
  const effMode = isVerifyPercent ? getPath(resolved?.effective, field.modePath) : undefined;
  const eff = isVerifyPercent ? verifyPercentOf(resolved?.effective, field) : getPath(resolved?.effective, field.path);
  const def = isVerifyPercent
    ? getPath(resolved?.definition, effMode === "full" ? field.modePath : field.path)
    : isSchedule
      ? getPath(resolved?.effective, field.path)
        ? getPath(resolved?.definition, field.path)
        : getPath(resolved?.definition, field.altPath)
      : getPath(resolved?.definition, field.path);
  const text = isVerifyPercent
    ? eff === undefined || eff === null
      ? ""
      : `${eff}%`
    : isSchedule
      ? scheduleText(resolved?.effective, field)
      : effectiveText(field, eff);
  const readonly = field.type === "readonly";

  // a verifyPercent field reads one path but writes two: 100 means "full" (mode set, percent cleared),
  // anything else means "sample" (percent set, mode cleared so the server's own sample default applies)
  const handleChange = isVerifyPercent
    ? (v) => {
        if (v === undefined) {
          onChange(field.path, undefined);
          onChange(field.modePath, undefined);
        } else if (v >= 100) {
          onChange(field.path, undefined);
          onChange(field.modePath, "full");
        } else {
          onChange(field.path, v);
          onChange(field.modePath, undefined);
        }
      }
    : (v) => onChange(field.path, v);

  return (
    <div className="nx-policy-row" data-testid={"policy-" + field.path}>
      <div>
        <div className="fw-semibold">{field.label}</div>
        <div className="nx-help">{field.help}</div>
        {readonly && field.link && <Link to={field.link}>Open {field.link.slice(1)}</Link>}
      </div>
      <div>
        {readonly ? (
          <span className="nx-muted small">managed elsewhere</span>
        ) : isSchedule ? (
          <ScheduleControl field={field} policy={policy} onChange={onChange} />
        ) : (
          <Control field={field} value={mine} onChange={handleChange} algorithms={algorithms} />
        )}
      </div>
      <div data-testid={"effective-" + field.path}>
        {field.type === "lines" || readonly ? (
          eff?.length ? (
            <div className="small" style={{ maxHeight: "8rem", overflowY: "auto" }}>
              {eff.map((x) => (
                <div key={x}>
                  <PathText>{x}</PathText>
                </div>
              ))}
            </div>
          ) : (
            <span className="nx-muted">none</span>
          )
        ) : text ? (
          <span>{text}</span>
        ) : (
          <span className="nx-muted">not set</span>
        )}
        {def && text && <div className="nx-help">from {definedBy(def, target)}</div>}
      </div>
    </div>
  );
}

/** Whether this policy (not what it inherits) sets anything in a section, for bolding its tab. */
function sectionHasValue(policy, section) {
  return section.fields.some(
    (f) =>
      hasValue(getPath(policy, f.path)) ||
      (f.altPath && hasValue(getPath(policy, f.altPath))) ||
      (f.modePath && hasValue(getPath(policy, f.modePath))),
  );
}

/**
 * All the settings of a policy, one section at a time. policyState is what usePolicy returns. hideSourceOnly
 * drops the tabs that only ever take effect for a source itself (Retention, Schedule, Upload) -- pass it for a
 * target that is a subfolder of a source, or not part of one at all.
 */
export function PolicyFields({ target, policyState, initialSection = "retention", hideSourceOnly = false }) {
  const groups = hideSourceOnly ? SECTION_GROUPS.filter((g) => !g.sourceOnly) : SECTION_GROUPS;
  const [section, setSection] = useState(() =>
    groups.some((g) => g.sections.includes(initialSection)) ? initialSection : groups[0].sections[0],
  );
  const { policy, change, resolved, algorithms } = policyState;
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const group = groups.find((g) => g.sections.includes(current.id)) ?? groups[0];
  const subSections = group.sections.length > 1 ? group.sections.map((id) => SECTIONS.find((s) => s.id === id)) : null;
  const groupHasValue = (g) =>
    g.sections.some((id) => sectionHasValue(policy, SECTIONS.find((s) => s.id === id)));

  return (
    <div className="nx-stack" data-testid="policy-fields">
      <TabNav
        tabs={groups.map((g) => ({ id: g.id, label: g.label, strong: groupHasValue(g) }))}
        active={group.id}
        onChange={(gid) => setSection(groups.find((g) => g.id === gid).sections[0])}
      />
      {subSections && (
        <TabNav
          tabs={subSections.map((s) => ({ id: s.id, label: s.label, strong: sectionHasValue(policy, s) }))}
          active={section}
          onChange={setSection}
        />
      )}
      <div className="nx-policy">
        <div className="nx-policy-row nx-policy-head">
          <div>Setting</div>
          <div>This policy</div>
          <div>In effect</div>
        </div>
        {current.fields.map((f) => (
          <Row
            key={f.path}
            field={f}
            policy={policy}
            onChange={change}
            resolved={resolved}
            target={target}
            algorithms={algorithms}
          />
        ))}
        {resolved && current.id === "scheduling" && (
          <Upcoming
            title="Next snapshots"
            error={resolved.schedulingError}
            times={resolved.upcomingSnapshotTimes}
            testId="upcoming-snapshot-times"
          />
        )}
        {resolved && current.id === "verifyScheduling" && (
          <Upcoming
            title="Next verifies"
            error={resolved.verifySchedulingError}
            times={resolved.upcomingVerifyTimes}
            testId="upcoming-verify-times"
          />
        )}
      </div>
    </div>
  );
}

/** The next few times a schedule (snapshots or verify) will run, or why it can't say. */
function Upcoming({ title, error, times, testId }) {
  return (
    <div className="nx-policy-row" data-testid="upcoming">
      <div>
        <div className="fw-semibold">{title}</div>
        <div className="nx-help">From the schedule above.</div>
      </div>
      <div />
      <div>
        {error ? (
          <StatusBadge kind="error">{error}</StatusBadge>
        ) : times?.length ? (
          <ul data-testid={testId}>
            {times.map((t) => (
              <li key={t}>{formatDateTime(t)}</li>
            ))}
          </ul>
        ) : (
          <span className="nx-muted">none scheduled</span>
        )}
      </div>
    </div>
  );
}
