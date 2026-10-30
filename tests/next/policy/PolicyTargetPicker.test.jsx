import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, afterEach } from "vitest";
import { PolicyTargetPicker, sourceRelationship } from "../../../src/next/policy/PolicyTargetPicker";

const sources = [
  { userName: "me", host: "mac", path: "/Users/me" },
  { userName: "me", host: "mac", path: "/Applications" },
  { userName: "you", host: "other", path: "/data" },
];

describe("sourceRelationship", () => {
  it("says a source's own path is its root", () => {
    expect(sourceRelationship({ userName: "me", host: "mac", path: "/Users/me" }, sources)).toEqual({
      owner: sources[0],
      isSourceRoot: true,
    });
  });

  it("finds the owning source for a subfolder", () => {
    expect(sourceRelationship({ userName: "me", host: "mac", path: "/Users/me/Downloads" }, sources)).toEqual({
      owner: sources[0],
      isSourceRoot: false,
    });
  });

  it("finds no owner for a path outside every source", () => {
    expect(sourceRelationship({ userName: "me", host: "mac", path: "/tmp/scratch" }, sources)).toEqual({
      owner: undefined,
      isSourceRoot: false,
    });
  });

  it("never matches a same-named prefix that is not actually nested", () => {
    // /Users/mel is not inside /Users/me even though it starts with the same characters
    expect(sourceRelationship({ userName: "me", host: "mac", path: "/Users/mel" }, sources).owner).toBeUndefined();
  });
});

describe("PolicyTargetPicker", () => {
  afterEach(() => {
    delete window.kopiaUI;
  });

  it("lists sources filtered as you type, and picks one by clicking it (never free text)", () => {
    const onPick = vi.fn();
    render(
      <PolicyTargetPicker
        target={{ userName: "", host: "", path: "" }}
        sources={sources}
        onPick={onPick}
        showCombo
      />,
    );

    fireEvent.focus(screen.getByLabelText("Source"));
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "app" } });
    expect(screen.getByText("/Applications")).toBeInTheDocument();
    expect(screen.queryByText("/Users/me")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("/Applications"));
    expect(onPick).toHaveBeenCalledWith({ userName: "me", host: "mac", path: "/Applications" });
  });

  it("hides the source combo once bound to a real target, by default", () => {
    render(
      <PolicyTargetPicker target={{ userName: "me", host: "mac", path: "/Users/me" }} sources={sources} onPick={() => {}} />,
    );
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
    expect(screen.queryByText("Policy for")).not.toBeInTheDocument();
  });

  it("shows no banner for a source's own root (it's the ordinary case), with no Browse in a plain browser", () => {
    render(
      <PolicyTargetPicker target={{ userName: "me", host: "mac", path: "/Users/me" }} sources={sources} onPick={() => {}} />,
    );
    expect(screen.queryByText(/one of your sources/)).not.toBeInTheDocument();
    expect(screen.queryByText("Browse…")).not.toBeInTheDocument();
  });

  it("shows an info banner naming the owning source for a subfolder", () => {
    render(
      <PolicyTargetPicker
        target={{ userName: "me", host: "mac", path: "/Users/me/Downloads" }}
        sources={sources}
        onPick={() => {}}
      />,
    );
    expect(screen.getByText(/subfolder of your source/)).toBeInTheDocument();
  });

  it("shows a warning banner for a path that is not part of any source", () => {
    render(
      <PolicyTargetPicker target={{ userName: "me", host: "mac", path: "/tmp/scratch" }} sources={sources} onPick={() => {}} />,
    );
    expect(screen.getByText(/isn.t part of any of your sources/)).toBeInTheDocument();
  });

  it("offers Browse once a source is known, constrained to stay inside it", () => {
    const onPick = vi.fn();
    const selectDirectory = vi.fn((cb) => cb("/Users/me/Downloads"));
    window.kopiaUI = { selectDirectory };
    render(
      <PolicyTargetPicker target={{ userName: "me", host: "mac", path: "/Users/me" }} sources={sources} onPick={onPick} />,
    );

    fireEvent.click(screen.getByText("Browse…"));
    expect(selectDirectory).toHaveBeenCalledWith(expect.any(Function), "/Users/me");
    expect(onPick).toHaveBeenCalledWith({ userName: "me", host: "mac", path: "/Users/me/Downloads" });
  });

  it("refuses a browsed folder outside the source instead of picking it", () => {
    const onPick = vi.fn();
    window.kopiaUI = { selectDirectory: (cb) => cb("/etc") };
    render(
      <PolicyTargetPicker target={{ userName: "me", host: "mac", path: "/Users/me" }} sources={sources} onPick={onPick} />,
    );

    fireEvent.click(screen.getByText("Browse…"));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a folder inside /Users/me");
  });
});
