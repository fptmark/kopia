import { useRef } from "react";
import "../css/SegmentedField.css";

/**
 * A date-picker style field made of parts. A part is highlighted when selected (by clicking it or with the left
 * and right arrows) and is changed by typing, with the up and down arrows, or with Backspace. Leaving the whole
 * field, or pressing Enter, calls onLeave.
 *
 * Each part is { ariaLabel, text, type(key, bufferRef), step(direction), erase(bufferRef) }. type returns null
 * for a key it does not use, or { set, done }: set applies the edit, and done moves on to the next part. The
 * buffer holds the digits typed so far into the selected part; it is cleared when the selection moves.
 */
export function SegmentedField({ ariaLabel, parts, onLeave, className = "" }) {
  const segmentsRef = useRef([]);
  const bufferRef = useRef("");

  const focus = (i) => segmentsRef.current[i]?.focus();

  const onKeyDown = (i, e) => {
    const part = parts[i];

    if (e.key === "ArrowLeft") {
      bufferRef.current = "";
      focus(Math.max(0, i - 1));
    } else if (e.key === "ArrowRight") {
      bufferRef.current = "";
      focus(Math.min(parts.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      bufferRef.current = "";
      part.step?.(e.key === "ArrowUp" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.currentTarget.blur(); // leaving the field applies the edit
    } else if (e.key === "Backspace" || e.key === "Delete") {
      part.erase?.(bufferRef);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const r = part.type?.(e.key, bufferRef);
      if (!r) {
        e.preventDefault();
        return;
      }
      r.set();
      if (r.done) {
        bufferRef.current = "";
        focus(Math.min(parts.length - 1, i + 1));
      }
    } else {
      return; // Tab and the rest behave as usual
    }
    e.preventDefault();
  };

  return (
    <span
      className={`segmented-field ${className}`}
      role="group"
      aria-label={ariaLabel}
      onBlur={(e) => {
        // focus moving from one part to another is not leaving the field
        if (!e.currentTarget.contains(e.relatedTarget)) {
          bufferRef.current = "";
          onLeave?.();
        }
      }}
    >
      {parts.map((p, i) => (
        <span
          key={p.ariaLabel}
          ref={(el) => {
            segmentsRef.current[i] = el;
          }}
          className="segment"
          role="spinbutton"
          tabIndex={0}
          aria-label={p.ariaLabel}
          aria-valuetext={p.text}
          onKeyDown={(e) => onKeyDown(i, e)}
        >
          {p.text}
        </span>
      ))}
    </span>
  );
}
