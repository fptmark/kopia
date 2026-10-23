import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { DurationInput } from "../../src/components/DurationInput";

afterEach(cleanup);

const setup = (props = {}) => {
  const onCommit = vi.fn();
  render(
    <DurationInput
      ariaLabel="Period"
      seconds={3600}
      onCommit={onCommit}
      minSeconds={60}
      maxSeconds={86400 * 30}
      {...props}
    />,
  );
  return { onCommit, number: screen.getByLabelText("Period"), unit: screen.getByLabelText("Period unit") };
};

describe("DurationInput", () => {
  it("shows the period as a number and a unit, with sec, min, hr and days to choose from", () => {
    const { number, unit } = setup({ seconds: 5400 });

    expect(number).toHaveValue("90");
    expect(unit).toHaveValue("min");
    expect([...unit.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["sec", "min", "hr", "days"]);
  });

  it("reports a new value when the number is left, not on every keystroke", () => {
    const { onCommit, number } = setup();

    fireEvent.change(number, { target: { value: "2" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(number);
    expect(onCommit).toHaveBeenCalledWith(7200);
  });

  it("reports when Enter is pressed", () => {
    const { onCommit, number } = setup();

    number.focus();
    fireEvent.change(number, { target: { value: "3" } });
    fireEvent.keyDown(number, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(10800);
  });

  it("reports when the unit changes, keeping the number", () => {
    const { onCommit, unit } = setup();

    fireEvent.change(unit, { target: { value: "days" } });
    expect(onCommit).toHaveBeenCalledWith(86400);
  });

  it("does not report a value that did not change", () => {
    const { onCommit, number } = setup();

    fireEvent.change(number, { target: { value: "60" } });
    fireEvent.blur(number);
    expect(onCommit).toHaveBeenCalledTimes(1); // 60 hr is a change...
    onCommit.mockClear();
    fireEvent.change(number, { target: { value: "1" } });
    fireEvent.blur(number);
    expect(onCommit).not.toHaveBeenCalled(); // ...but 1 hr, the stored value, is not
  });

  it("refuses values outside the limits or that are not numbers, and puts the stored one back", () => {
    const { onCommit, number, unit } = setup({ invalidMessage: "Not a good period." });

    // the number is typed first, then left by the blur or by choosing the unit
    const leaveByBlur = (text) => {
      fireEvent.change(number, { target: { value: text } });
      fireEvent.blur(number);
    };
    const leaveByUnit = (text, u) => {
      fireEvent.change(number, { target: { value: text } });
      fireEvent.change(unit, { target: { value: u } });
    };

    for (const go of [
      () => leaveByBlur("abc"),
      () => leaveByBlur("0"),
      () => leaveByBlur(""),
      () => leaveByUnit("30", "sec"), // under the 1 minute limit
      () => leaveByUnit("31", "days"), // over the 30 day limit
    ]) {
      go();
      expect(screen.getByRole("alert")).toHaveTextContent("Not a good period.");
      expect(onCommit).not.toHaveBeenCalled();
      expect(number).toHaveValue("1");
      expect(unit).toHaveValue("hr");
    }
  });

  it("clears the message after a good value", () => {
    const { number } = setup();

    fireEvent.change(number, { target: { value: "x" } });
    fireEvent.blur(number);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.change(number, { target: { value: "2" } });
    fireEvent.blur(number);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("can be emptied when nothing is a valid setting", () => {
    const { onCommit, number } = setup({ allowEmpty: true });

    fireEvent.change(number, { target: { value: "" } });
    fireEvent.blur(number);
    expect(onCommit).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a chosen unit while nothing is typed yet", () => {
    const { onCommit, unit } = setup({ seconds: undefined, allowEmpty: true });

    expect(screen.getByLabelText("Period")).toHaveValue("");
    fireEvent.change(unit, { target: { value: "days" } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(unit).toHaveValue("days");

    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "2" } });
    fireEvent.blur(screen.getByLabelText("Period"));
    expect(onCommit).toHaveBeenCalledWith(172800);
  });
});
