import React, { useState } from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import {
  ConfirmDialog,
  CountText,
  DateTimeText,
  EmptyState,
  Field,
  Loaded,
  Notice,
  FromLink,
  Page,
  Panel,
  PathText,
  SizeText,
  Stat,
  StatusBadge,
  SwitchField,
  TabNav,
  Toolbar,
} from "../../../src/next/ui";

const inRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Page", () => {
  it("shows title, subtitle, actions and the breadcrumbs", () => {
    inRouter(
      <Page
        title="History"
        subtitle="of a path"
        trail={[{ label: "Snapshots", to: "/snapshots" }]}
        actions={<button>Do</button>}
      >
        body
      </Page>,
    );
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByText("of a path")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Snapshots/ })).toHaveAttribute("href", "/snapshots");
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("shows the trail it was opened from, then itself", () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/tasks/9",
            state: {
              from: [
                { label: "Sources", to: "/snapshots" },
                { label: "/Users/me", to: "/snapshots/single-source?x=1" },
              ],
            },
          },
        ]}
      >
        <Page title="Snapshot: long description" trail={[{ label: "Tasks", to: "/tasks" }]} crumb="Details">
          body
        </Page>
      </MemoryRouter>,
    );
    const crumbs = within(screen.getByLabelText("Where you are"));
    expect(crumbs.getAllByRole("listitem").map((x) => x.textContent)).toEqual(["Sources", "/Users/me", "Details"]);
    expect(crumbs.queryByRole("link", { name: "Details" })).not.toBeInTheDocument();
    expect(crumbs.queryByRole("link", { name: "Tasks" })).not.toBeInTheDocument();
  });

  it("hands its own trail to the page a FromLink opens", () => {
    const Dest = () => {
      const l = useLocation();
      return <div data-testid="from">{(l.state?.from ?? []).map((c) => c.label).join(" > ")}</div>;
    };
    render(
      <MemoryRouter initialEntries={["/snapshots/single-source"]}>
        <Routes>
          <Route
            path="/snapshots/single-source"
            element={
              <Page trail={[{ label: "Sources", to: "/snapshots" }, { label: "/Users/me" }]}>
                <FromLink to="/policies/edit">Policy</FromLink>
              </Page>
            }
          />
          <Route path="/policies/edit" element={<Dest />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("Policy"));
    expect(screen.getByTestId("from")).toHaveTextContent("Sources > /Users/me");
  });

  it("links each breadcrumb but the current one", () => {
    inRouter(
      <Page
        title="T"
        trail={[
          { label: "Snapshots", to: "/snapshots" },
          { label: "Docs", to: "/snapshots/dir/k1", state: { label: "Docs" } },
          { label: "Here" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/snapshots/dir/k1");
    expect(screen.queryByRole("link", { name: "Here" })).not.toBeInTheDocument();
    expect(screen.getByText("Here")).toBeInTheDocument();
  });
});

describe("Panel, Toolbar, Stat", () => {
  it("renders the title, note, actions and body", () => {
    render(
      <Panel title="Totals" note="all time" actions={<button>Go</button>}>
        <Stat label="Size" value="1 GB" note="logical" />
      </Panel>,
    );
    expect(screen.getByRole("heading", { name: "Totals" })).toBeInTheDocument();
    expect(screen.getByText("all time")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("1 GB")).toBeInTheDocument();
    expect(screen.getByText("logical")).toBeInTheDocument();
  });

  it("draws a group with its label", () => {
    render(
      <Toolbar>
        <Toolbar.Group label="Show" grow>
          <span>x</span>
        </Toolbar.Group>
        <Toolbar.Group end>
          <span>y</span>
        </Toolbar.Group>
      </Toolbar>,
    );
    expect(screen.getByText("Show")).toBeInTheDocument();
    expect(screen.getByText("x").parentElement).toHaveClass("nx-toolbar-group", "grow");
    expect(screen.getByText("y").parentElement).toHaveClass("end");
  });
});

describe("cells", () => {
  const withPrefs = (ui, prefs = {}) =>
    render(
      <UIPreferencesContext.Provider value={{ bytesStringBase2: false, ...prefs }}>{ui}</UIPreferencesContext.Provider>,
    );

  it("shows sizes in the chosen base, with the exact bytes on hover, and a dash when unknown", () => {
    withPrefs(<SizeText bytes={1500000} />);
    expect(screen.getByText("1.5 MB")).toHaveAttribute("title", "1,500,000 bytes");
  });

  it("uses base 2 when preferred", () => {
    withPrefs(<SizeText bytes={1048576} />, { bytesStringBase2: true });
    expect(screen.getByText("1 MiB")).toBeInTheDocument();
  });

  it("shows a dash for a missing size", () => {
    withPrefs(<SizeText bytes={undefined} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shortens counts and keeps the full number on hover", () => {
    render(<CountText n={1311967} />);
    expect(screen.getByText("1.3M")).toHaveAttribute("title", "1,311,967");
  });

  it("shows dates and relative dates", () => {
    const { rerender } = render(<DateTimeText value="2026-10-23T17:22:07Z" />);
    expect(screen.getByText(/Oct 23, 2026/)).toBeInTheDocument();
    rerender(<DateTimeText value={new Date(Date.now() - 3 * 3600 * 1000).toISOString()} ago />);
    expect(screen.getByText("3 h ago")).toBeInTheDocument();
    rerender(<DateTimeText value="" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows paths in the code font, with a slash for folders", () => {
    render(<PathText dir>Library/Caches</PathText>);
    expect(screen.getByText("Library/Caches/")).toHaveClass("nx-path");
  });

  it("gives each status its own class", () => {
    render(<StatusBadge kind="removed" />);
    expect(screen.getByText("removed")).toHaveClass("nx-badge", "removed");
  });
});

describe("feedback", () => {
  it("Notice has the role that matches its kind", () => {
    const { rerender } = render(<Notice kind="error">bad</Notice>);
    expect(screen.getByRole("alert")).toHaveTextContent("bad");
    rerender(<Notice kind="success">fine</Notice>);
    expect(screen.getByRole("status")).toHaveTextContent("fine");
  });

  it("Notice can be dismissed", () => {
    const onClose = vi.fn();
    render(
      <Notice kind="info" onClose={onClose}>
        hi
      </Notice>,
    );
    fireEvent.click(screen.getByLabelText("Close alert"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Loaded shows a spinner, then the data, or the error with Try again", () => {
    const reload = vi.fn();
    const { rerender } = render(
      <Loaded state={{ data: undefined, error: null, reload }}>{(d) => <div>{d}</div>}</Loaded>,
    );
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    rerender(<Loaded state={{ data: "the data", error: null, reload }}>{(d) => <div>{d}</div>}</Loaded>);
    expect(screen.getByText("the data")).toBeInTheDocument();

    rerender(<Loaded state={{ data: undefined, error: "no route to host", reload }}>{(d) => <div>{d}</div>}</Loaded>);
    expect(screen.getByRole("alert")).toHaveTextContent("no route to host");
    fireEvent.click(screen.getByText("Try again"));
    expect(reload).toHaveBeenCalled();
  });

  it("Loaded keeps showing old data when a refresh fails", () => {
    render(<Loaded state={{ data: "old", error: "boom", reload: vi.fn() }}>{(d) => <div>{d}</div>}</Loaded>);
    expect(screen.getByText("old")).toBeInTheDocument();
  });

  it("EmptyState shows its text", () => {
    render(<EmptyState>Nothing.</EmptyState>);
    expect(screen.getByText("Nothing.")).toBeInTheDocument();
  });
});

describe("forms", () => {
  it("Field points its label at the input", () => {
    render(
      <Field label="Name" help="Shown at the top." error="Required.">
        {(id) => <input id={id} />}
      </Field>,
    );
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByText("Shown at the top.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Required.");
  });

  it("SwitchField reports the new value", () => {
    const onChange = vi.fn();
    render(<SwitchField label="Awake" help="While running." checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Awake"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("TabNav marks the active tab and reports a click", () => {
    function T() {
      const [t, setT] = useState("a");
      return (
        <>
          <TabNav
            tabs={[
              { id: "a", label: "First", badge: 3 },
              { id: "b", label: "Second" },
            ]}
            active={t}
            onChange={setT}
          />
          <span data-testid="now">{t}</span>
        </>
      );
    }
    render(<T />);
    expect(screen.getByTestId("tab-a")).toHaveClass("active");
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-b"));
    expect(screen.getByTestId("now")).toHaveTextContent("b");
    expect(screen.getByTestId("tab-b")).toHaveClass("active");
  });
});

describe("ConfirmDialog", () => {
  it("confirms, cancels, and disables the confirm button while busy", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog show title="Delete?" confirmLabel="Delete" danger onConfirm={onConfirm} onCancel={onCancel}>
        sure?
      </ConfirmDialog>,
    );
    expect(screen.getByText("sure?")).toBeInTheDocument();
    expect(screen.getByTestId("confirm")).toHaveClass("btn-danger");
    fireEvent.click(screen.getByTestId("confirm"));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();

    rerender(
      <ConfirmDialog show title="Delete?" busy onConfirm={onConfirm} onCancel={onCancel}>
        sure?
      </ConfirmDialog>,
    );
    expect(screen.getByTestId("confirm")).toBeDisabled();
  });
});
