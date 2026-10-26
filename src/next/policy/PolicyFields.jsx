import React, { useState } from "react";
import Form from "react-bootstrap/Form";
import { Link } from "react-router";
import { DurationInput } from "../../components/DurationInput";
import { formatDuration } from "../../utils/duration";
import { formatDateTime } from "../format";
import { PathText, StatusBadge, TabNav } from "../ui";
import { SECTIONS } from "./fields";
import { definedBy, getPath, linesToText, textToLines, textToTimes, timesToText } from "./helpers";

/** What a setting is in effect, as text. */
function effectiveText(field, value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  switch (field.type) {
    case "bool":
    case "flag":
      return value ? "yes" : "no";
    case "duration":
      return formatDuration(value);
    case "times":
      return timesToText(value).split("\n").join(", ");
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
    case "times":
      return (
        <Form.Control
          size="sm"
          as="textarea"
          rows={3}
          aria-label={label}
          value={timesToText(value)}
          onChange={(e) => onChange(textToTimes(e.target.value))}
        />
      );
    case "duration":
      return (
        <DurationInput
          ariaLabel={label}
          seconds={value || undefined}
          allowEmpty
          minSeconds={60}
          maxSeconds={365 * 86400}
          invalidMessage="Enter a number and a unit: at least 1 minute, at most 365 days."
          onCommit={onChange}
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

function Row({ field, policy, onChange, resolved, target, algorithms }) {
  const mine = getPath(policy, field.path);
  const eff = getPath(resolved?.effective, field.path);
  const def = getPath(resolved?.definition, field.path);
  const text = effectiveText(field, eff);
  const readonly = field.type === "readonly";

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
        ) : (
          <Control field={field} value={mine} onChange={(v) => onChange(field.path, v)} algorithms={algorithms} />
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

/** All the settings of a policy, one section at a time. policyState is what usePolicy returns. */
export function PolicyFields({ target, policyState, initialSection = "retention" }) {
  const [section, setSection] = useState(initialSection);
  const { policy, change, resolved, algorithms } = policyState;
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="nx-stack" data-testid="policy-fields">
      <TabNav tabs={SECTIONS.map((s) => ({ id: s.id, label: s.label }))} active={section} onChange={setSection} />
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
        {current.id === "scheduling" && <Upcoming resolved={resolved} />}
      </div>
    </div>
  );
}

function Upcoming({ resolved }) {
  if (!resolved) {
    return null;
  }
  return (
    <div className="nx-policy-row" data-testid="upcoming">
      <div>
        <div className="fw-semibold">Next snapshots</div>
        <div className="nx-help">From the schedule above.</div>
      </div>
      <div />
      <div>
        {resolved.schedulingError ? (
          <StatusBadge kind="error">{resolved.schedulingError}</StatusBadge>
        ) : resolved.upcomingSnapshotTimes?.length ? (
          <ul data-testid="upcoming-snapshot-times">
            {resolved.upcomingSnapshotTimes.map((t) => (
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
