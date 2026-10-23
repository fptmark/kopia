import { useState } from "react";
import Form from "react-bootstrap/Form";
import { DURATION_UNITS, parseDuration, splitDuration } from "../utils/duration";

/**
 * A period typed as a number and a unit (sec, min, hr, days). It reports a valid new value with onCommit when the
 * number is left or the unit is changed; a value outside the limits or not a number is refused with a message and
 * the previous value is put back. With allowEmpty, clearing the number reports undefined.
 */
export function DurationInput({
  seconds,
  onCommit,
  minSeconds = 1,
  maxSeconds = Number.MAX_SAFE_INTEGER,
  allowEmpty = false,
  invalidMessage = "Enter a number and a unit.",
  ariaLabel,
  size = "sm",
}) {
  const shown = splitDuration(seconds);
  // what is being typed, or null while the field shows the stored value
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const text = draft?.text ?? shown.text;
  const unit = draft?.unit ?? shown.unit;

  const commit = (nextText, nextUnit) => {
    setDraft(null);

    if (nextText.trim() === "" && allowEmpty) {
      setError("");
      if (seconds) {
        onCommit(undefined);
      }
      return;
    }

    const value = parseDuration(nextText, nextUnit);
    if (value === null || value < minSeconds || value > maxSeconds) {
      setError(invalidMessage);
      return;
    }

    setError("");
    if (value !== seconds) {
      onCommit(value);
    }
  };

  return (
    <>
      <Form.Control
        size={size}
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        placeholder={allowEmpty ? "—" : undefined}
        value={text}
        onChange={(e) => setDraft({ text: e.target.value, unit })}
        onBlur={() => draft && commit(draft.text, draft.unit)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        style={{ width: "4.5rem", display: "inline-block" }}
      />
      <Form.Select
        size={size}
        aria-label={`${ariaLabel} unit`}
        value={unit}
        onChange={(e) =>
          // with nothing typed yet there is nothing to save: just remember the unit
          text.trim() === "" ? setDraft({ text, unit: e.target.value }) : commit(text, e.target.value)
        }
        style={{ width: "auto", display: "inline-block" }}
      >
        {DURATION_UNITS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.id}
          </option>
        ))}
      </Form.Select>
      {error && (
        <span className="text-danger small" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
