import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import { vi } from "vitest";
import { typeLetter, typeNumber, WhenField } from "../../src/components/WhenField";

// a field that keeps its own state, the way the page does
function Harness({ initial, onChange = () => {} }) {
  const [v, setV] = useState(initial);
  return (
    <WhenField
      name="Mail"
      {...v}
      onChange={(patch) => {
        setV((old) => ({ ...old, ...patch }));
        onChange(patch);
      }}
    />
  );
}

const seg = (label) => screen.getByLabelText(`${label} for Mail`);
const press = (el, key) => fireEvent.keyDown(el, { key });
const text = (label) => seg(label).textContent;

describe("WhenField", () => {
  it("shows only the parts a frequency needs", () => {
    const { unmount } = render(<WhenField name="Mail" freq="daily" time="08:00" onChange={() => {}} />);
    expect(screen.queryByLabelText("Day of week for Mail")).not.toBeInTheDocument();
    expect(text("Hour")).toBe("8");
    expect(text("AM or PM")).toBe("AM");
    unmount();

    const w = render(<WhenField name="Mail" freq="weekly" weekday={0} time="17:00" onChange={() => {}} />);
    expect(text("Day of week")).toBe("Mon");
    expect(text("Hour")).toBe("5");
    expect(text("AM or PM")).toBe("PM");
    w.unmount();

    render(<WhenField name="Mail" freq="monthly" dom={22} time="08:00" onChange={() => {}} />);
    expect(text("Day of month")).toBe("22nd");
  });

  it("has no minutes and no pop-up lists: one field with parts", () => {
    render(<WhenField name="Mail" freq="weekly" time="08:00" onChange={() => {}} />);
    expect(screen.queryByLabelText(/Minute/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(3);
  });

  it("moves between the parts with the left and right arrows", () => {
    render(<WhenField name="Mail" freq="weekly" time="08:00" onChange={() => {}} />);

    seg("Day of week").focus();
    press(seg("Day of week"), "ArrowRight");
    expect(seg("Hour")).toHaveFocus();
    press(seg("Hour"), "ArrowRight");
    expect(seg("AM or PM")).toHaveFocus();
    press(seg("AM or PM"), "ArrowRight");
    expect(seg("AM or PM")).toHaveFocus(); // stops at the end
    press(seg("AM or PM"), "ArrowLeft");
    press(seg("Hour"), "ArrowLeft");
    expect(seg("Day of week")).toHaveFocus();
    press(seg("Day of week"), "ArrowLeft");
    expect(seg("Day of week")).toHaveFocus();
  });

  it("types an hour and moves on when it cannot get longer", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ freq: "daily", time: "08:00" }} onChange={onChange} />);

    seg("Hour").focus();
    press(seg("Hour"), "5");
    expect(onChange).toHaveBeenLastCalledWith({ time: "05:00" });
    expect(seg("AM or PM")).toHaveFocus();
    expect(text("Hour")).toBe("5");
  });

  it("waits after a 1 for a second digit: 1 then 1 is 11, 1 then 3 starts over as 3", () => {
    render(<Harness initial={{ freq: "daily", time: "08:00" }} />);

    seg("Hour").focus();
    press(seg("Hour"), "1");
    expect(text("Hour")).toBe("1");
    expect(seg("Hour")).toHaveFocus(); // still waiting
    press(seg("Hour"), "1");
    expect(text("Hour")).toBe("11");
    expect(seg("AM or PM")).toHaveFocus();

    seg("Hour").focus();
    press(seg("Hour"), "1");
    press(seg("Hour"), "3"); // 13 is not an hour
    expect(text("Hour")).toBe("3");
  });

  it("ignores a zero and letters in the hour", () => {
    render(<Harness initial={{ freq: "daily", time: "08:00" }} />);

    seg("Hour").focus();
    press(seg("Hour"), "0");
    press(seg("Hour"), "x");
    expect(text("Hour")).toBe("8");
  });

  it("sets AM and PM with a and p, stored as 24-hour time on the hour", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ freq: "daily", time: "08:30" }} onChange={onChange} />);

    press(seg("AM or PM"), "p");
    expect(onChange).toHaveBeenLastCalledWith({ time: "20:00" }); // minutes set by hand are dropped
    expect(text("AM or PM")).toBe("PM");
    press(seg("AM or PM"), "A");
    expect(onChange).toHaveBeenLastCalledWith({ time: "08:00" });
  });

  it("types a day of the week by its letter, and repeated letters cycle", () => {
    render(<Harness initial={{ freq: "weekly", weekday: 0, time: "08:00" }} />);

    const day = () => seg("Day of week");
    press(day(), "f");
    expect(text("Day of week")).toBe("Fri");
    expect(seg("Hour")).toHaveFocus();

    day().focus();
    press(day(), "t");
    expect(text("Day of week")).toBe("Tue");
    day().focus();
    press(day(), "t");
    expect(text("Day of week")).toBe("Thu");
    day().focus();
    press(day(), "s");
    expect(text("Day of week")).toBe("Sat");
    day().focus();
    press(day(), "s");
    expect(text("Day of week")).toBe("Sun");
  });

  it("types a day of the month, with l for the last day", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ freq: "monthly", dom: 1, time: "08:00" }} onChange={onChange} />);

    const day = () => seg("Day of month");
    press(day(), "2");
    press(day(), "2");
    expect(text("Day of month")).toBe("22nd");

    day().focus();
    press(day(), "l");
    expect(onChange).toHaveBeenLastCalledWith({ dom: 0 });
    expect(text("Day of month")).toBe("Last");

    day().focus();
    press(day(), "3"); // 3 can only be 3 (30 is past the 28th)
    expect(text("Day of month")).toBe("3rd");
  });

  it("changes a value with up and down too, wrapping round", () => {
    render(<Harness initial={{ freq: "weekly", weekday: 6, time: "12:00" }} />);

    press(seg("Day of week"), "ArrowUp");
    expect(text("Day of week")).toBe("Mon");
    press(seg("Hour"), "ArrowUp");
    expect(text("Hour")).toBe("1");
    press(seg("Hour"), "ArrowDown");
    expect(text("Hour")).toBe("12");
    press(seg("AM or PM"), "ArrowDown");
    expect(text("AM or PM")).toBe("AM");
  });

  it("leaves Tab and shortcuts to the browser", () => {
    render(<WhenField name="Mail" freq="daily" time="08:00" onChange={() => {}} />);

    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    seg("Hour").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);

    const c = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    seg("Hour").dispatchEvent(c);
    expect(c.defaultPrevented).toBe(false);
  });
});

describe("typing helpers", () => {
  it("typeNumber", () => {
    expect(typeNumber("", "5", 12)).toEqual({ value: 5, buffer: "5", done: true });
    expect(typeNumber("", "1", 12)).toEqual({ value: 1, buffer: "1", done: false });
    expect(typeNumber("1", "2", 12)).toEqual({ value: 12, buffer: "12", done: true });
    expect(typeNumber("1", "3", 12)).toEqual({ value: 3, buffer: "3", done: true });
    expect(typeNumber("", "0", 12)).toEqual({ value: null, buffer: "", done: false });
    expect(typeNumber("2", "9", 28)).toEqual({ value: 9, buffer: "9", done: true });
    expect(typeNumber("2", "8", 28)).toEqual({ value: 28, buffer: "28", done: true });
  });

  it("typeLetter", () => {
    const d = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    expect(typeLetter(d, 0, "w")).toBe(2);
    expect(typeLetter(d, 0, "T")).toBe(1);
    expect(typeLetter(d, 1, "t")).toBe(3);
    expect(typeLetter(d, 3, "t")).toBe(1); // wraps
    expect(typeLetter(d, 0, "x")).toBe(-1);
  });
});
