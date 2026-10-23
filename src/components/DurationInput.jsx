import { useState } from "react";
import { DURATION_UNITS, splitDuration } from "../utils/duration";
import { SegmentedField } from "./SegmentedField";

const MAX_DIGITS = 5;

const unitSeconds = (id) => DURATION_UNITS.find((u) => u.id === id).seconds;

/**
 * A period as a number and a unit (sec, min, hr, days), edited like a date picker: click or use the left and
 * right arrows to select the number or the unit; type digits, or use up and down, to change it; for the unit
 * type s, m, h or d. The edit is applied with onCommit when the field is left or Enter is pressed. A value
 * outside the limits is refused with a message and the stored one is put back. With allowEmpty, clearing the
 * number (Backspace) reports undefined.
 */
export function DurationInput({
  seconds,
  onCommit,
  minSeconds = 1,
  maxSeconds = Number.MAX_SAFE_INTEGER,
  allowEmpty = false,
  invalidMessage = "Enter a number and a unit.",
  ariaLabel,
}) {
  const stored = splitDuration(seconds);
  // the edit in progress, or null while the field shows the stored value
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");

  const current = draft ?? { n: stored.text === "" ? null : Number(stored.text), unit: stored.unit };

  // the numbers that keep the period within its limits in the current unit
  const lowest = Math.max(1, Math.ceil(minSeconds / unitSeconds(current.unit)));
  const highest = Math.floor(maxSeconds / unitSeconds(current.unit));

  const edit = (patch) => setDraft({ ...current, ...patch });

  const commit = () => {
    const d = draft;
    setDraft(null);
    if (!d) {
      return;
    }

    if (d.n === null) {
      if (allowEmpty) {
        setError("");
        if (seconds) {
          onCommit(undefined);
        }
      } else {
        setError(invalidMessage);
      }
      return;
    }

    const value = d.n * unitSeconds(d.unit);
    if (value < minSeconds || value > maxSeconds) {
      setError(invalidMessage);
      return;
    }

    setError("");
    if (value !== seconds) {
      onCommit(value);
    }
  };

  const parts = [
    {
      ariaLabel: `${ariaLabel} value`,
      text: current.n === null ? "—" : String(current.n),
      type: (key, buffer) => {
        if (!/^[0-9]$/.test(key)) {
          return null;
        }
        // the first digit replaces the number; more digits extend it
        const next = buffer.current.length >= MAX_DIGITS ? key : buffer.current + key;
        buffer.current = next;
        return { set: () => edit({ n: Number(next) }), done: false };
      },
      erase: (buffer) => {
        buffer.current = buffer.current === "" ? "" : buffer.current.slice(0, -1);
        edit({ n: buffer.current === "" ? null : Number(buffer.current) });
      },
      step: (d) => edit({ n: Math.min(highest, Math.max(lowest, (current.n ?? lowest - 1) + d)) }),
    },
    {
      ariaLabel: `${ariaLabel} unit`,
      text: current.unit,
      type: (key) => {
        const u = DURATION_UNITS.find((x) => x.id.startsWith(key.toLowerCase()));
        return u ? { set: () => edit({ unit: u.id }), done: false } : null;
      },
      step: (d) => {
        const i = DURATION_UNITS.findIndex((u) => u.id === current.unit);
        edit({ unit: DURATION_UNITS[(i + d + DURATION_UNITS.length) % DURATION_UNITS.length].id });
      },
    },
  ];

  return (
    <>
      <SegmentedField ariaLabel={ariaLabel} parts={parts} onLeave={commit} />
      {error && (
        <span className="text-danger small ms-1" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
