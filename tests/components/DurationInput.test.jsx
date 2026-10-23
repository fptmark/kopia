import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import { vi } from "vitest";
import { DurationInput } from "../../src/components/DurationInput";

afterEach(cleanup);

const press = (el, key) => fireEvent.keyDown(el, { key });
const typeKeys = (el, keys) => [...keys].forEach((k) => press(el, k));
const leave = (el) => fireEvent.blur(el); // focus going nowhere: the field is left

// keeps the committed value, the way a page does
function Harness({ initial, onCommit, ...props }) {
  const [seconds, setSeconds] = useState(initial);
  return (
    <DurationInput
      ariaLabel="Period"
      seconds={seconds}
      minSeconds={60}
      maxSeconds={30 * 86400}
      onCommit={(s) => {
        setSeconds(s);
        onCommit(s);
      }}
      {...props}
    />
  );
}

const setup = (initial = 3600, props = {}) => {
  const onCommit = vi.fn();
  render(<Harness initial={initial} onCommit={onCommit} {...props} />);
  return { onCommit, value: screen.getByLabelText("Period value"), unit: screen.getByLabelText("Period unit") };
};

describe("DurationInput", () => {
  it("is two selectable parts, a number and a unit, not a text box and a list", () => {
    const { value, unit } = setup(5400);

    expect(value).toHaveTextContent("90");
    expect(unit).toHaveTextContent("min");
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Period" })).toBeInTheDocument();
  });

  it("moves between the number and the unit with the left and right arrows", () => {
    const { value, unit } = setup();

    value.focus();
    press(value, "ArrowRight");
    expect(unit).toHaveFocus();
    press(unit, "ArrowRight");
    expect(unit).toHaveFocus(); // stops at the end
    press(unit, "ArrowLeft");
    expect(value).toHaveFocus();
    press(value, "ArrowLeft");
    expect(value).toHaveFocus();
  });

  it("types a number: the first digit replaces it and the next ones extend it", () => {
    const { value } = setup(3600);

    value.focus();
    press(value, "9");
    expect(value).toHaveTextContent("9");
    press(value, "0");
    expect(value).toHaveTextContent("90");
    press(value, "x"); // not a digit: ignored
    expect(value).toHaveTextContent("90");
  });

  it("applies the edit when the field is left, not while typing or moving between the parts", () => {
    const { onCommit, value, unit } = setup(3600);

    value.focus();
    typeKeys(value, "2");
    press(value, "ArrowRight");
    press(unit, "d");
    expect(onCommit).not.toHaveBeenCalled();

    leave(unit);
    expect(onCommit).toHaveBeenCalledWith(2 * 86400);
    expect(value).toHaveTextContent("2");
    expect(unit).toHaveTextContent("days");
  });

  it("does not apply when focus only moves from one part to the other", () => {
    const { onCommit, value, unit } = setup(3600);

    typeKeys(value, "5");
    fireEvent.blur(value, { relatedTarget: unit });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("applies when Enter is pressed", () => {
    const { onCommit, value } = setup(3600);

    value.focus();
    typeKeys(value, "3");
    press(value, "Enter");
    expect(onCommit).toHaveBeenCalledWith(3 * 3600);
  });

  it("chooses the unit by its first letter, or with up and down", () => {
    const { onCommit, value, unit } = setup(3600);

    press(unit, "s");
    expect(unit).toHaveTextContent("sec");
    press(unit, "m");
    expect(unit).toHaveTextContent("min");
    press(unit, "d");
    expect(unit).toHaveTextContent("days");
    press(unit, "h");
    expect(unit).toHaveTextContent("hr");
    press(unit, "x");
    expect(unit).toHaveTextContent("hr");

    press(unit, "ArrowUp");
    expect(unit).toHaveTextContent("days");
    press(unit, "ArrowUp");
    expect(unit).toHaveTextContent("sec"); // wraps round
    press(unit, "ArrowDown");
    expect(unit).toHaveTextContent("days");

    leave(value);
    expect(onCommit).toHaveBeenCalledWith(86400);
  });

  it("steps the number with up and down, never past the limits", () => {
    const { onCommit, value, unit } = setup(3600);

    press(value, "ArrowUp");
    expect(value).toHaveTextContent("2");
    press(value, "ArrowDown");
    press(value, "ArrowDown"); // 1 hr is the least a minute-or-more period can be in hours
    expect(value).toHaveTextContent("1");

    press(unit, "s"); // seconds: at least 60
    expect(value).toHaveTextContent("1");
    press(value, "ArrowUp"); // from nothing valid yet: starts at the lowest allowed number
    expect(value).toHaveTextContent("60");
    press(value, "ArrowDown");
    expect(value).toHaveTextContent("60");

    press(unit, "d"); // days: at most 30
    typeKeys(value, "29");
    press(value, "ArrowUp");
    press(value, "ArrowUp");
    expect(value).toHaveTextContent("30");

    leave(value);
    expect(onCommit).toHaveBeenCalledWith(30 * 86400);
  });

  it("refuses a value outside the limits, says so and puts the stored one back", () => {
    const { onCommit, value, unit } = setup(3600, { invalidMessage: "Not a good period." });

    typeKeys(value, "0");
    leave(value);
    expect(screen.getByRole("alert")).toHaveTextContent("Not a good period.");
    expect(onCommit).not.toHaveBeenCalled();
    expect(value).toHaveTextContent("1");
    expect(unit).toHaveTextContent("hr");

    press(unit, "s");
    typeKeys(value, "30"); // 30 seconds is under the minute
    leave(unit);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(value).toHaveTextContent("1");
    expect(unit).toHaveTextContent("hr");

    press(unit, "d");
    typeKeys(value, "31"); // over 30 days
    leave(value);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("clears the message after a good value", () => {
    const { onCommit, value } = setup(3600);

    typeKeys(value, "0");
    leave(value);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    typeKeys(value, "2");
    leave(value);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledWith(7200);
  });

  it("does not report a value that did not change", () => {
    const { onCommit, value } = setup(3600);

    typeKeys(value, "1");
    leave(value);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("erases digits with Backspace", () => {
    const { onCommit, value } = setup(3600);

    typeKeys(value, "123");
    press(value, "Backspace");
    expect(value).toHaveTextContent("12");
    press(value, "Backspace");
    press(value, "Backspace");
    expect(value).toHaveTextContent("—");

    // nothing is a valid period unless the setting may be empty
    leave(value);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
    expect(value).toHaveTextContent("1");
  });

  it("can be emptied when having no period is a valid setting", () => {
    const { onCommit, value } = setup(3600, { allowEmpty: true });

    press(value, "Backspace");
    expect(value).toHaveTextContent("—");
    leave(value);

    expect(onCommit).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows nothing selected yet when there is no period, and types one in", () => {
    const { onCommit, value, unit } = setup(null, { allowEmpty: true });

    expect(value).toHaveTextContent("—");
    typeKeys(value, "6");
    press(unit, "h");
    leave(unit);
    expect(onCommit).toHaveBeenCalledWith(6 * 3600);
  });

  it("leaves Tab and shortcuts to the browser", () => {
    const { value } = setup();

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    value.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);

    const copy = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    value.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
  });
});
