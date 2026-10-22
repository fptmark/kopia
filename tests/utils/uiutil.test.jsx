import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";
import { errorReason, FailuresModalHost, groupFailures, sizeWithFailures } from "../../src/utils/uiutil";

const summ = {
  numFailed: 2,
  errors: [
    { path: "Library/a.plist", error: "permission denied" },
    { path: "Library/b.run", error: "cannot create iterator" },
  ],
};

// A table that refreshes: every render creates brand new cell elements, like the polling snapshot tables do.
function Table({ tick }) {
  return (
    <div key={tick}>
      {sizeWithFailures(1000, summ, false)}
      <FailuresModalHost />
    </div>
  );
}

describe("snapshot failures dialog", () => {
  it("shows the failed paths when the icon is clicked", () => {
    render(<Table tick={0} />);
    fireEvent.click(screen.getByTestId("show-snapshot-errors"));
    expect(screen.getByText("Library/a.plist")).toBeInTheDocument();
    expect(screen.getByText("cannot create iterator")).toBeInTheDocument();
  });

  it("stays open when the table re-renders", () => {
    const { rerender } = render(<Table tick={0} />);
    fireEvent.click(screen.getByTestId("show-snapshot-errors"));
    rerender(<Table tick={1} />);
    rerender(<Table tick={2} />);
    expect(screen.getByText("Library/a.plist")).toBeInTheDocument();
  });

  it("renders no icon when there are no failures", () => {
    render(<div>{sizeWithFailures(5, { numFailed: 0 }, false)}</div>);
    expect(screen.queryByTestId("show-snapshot-errors")).toBeNull();
  });
});

const op = (p) => ({ path: p, error: `unable to open file: unable to open local file: open /Users/me/${p}: operation not permitted` });
const pd = (p) => ({ path: p, error: `unable to open local file: open /Users/me/${p}: permission denied` });

describe("errorReason", () => {
  it("drops the embedded path and keeps the cause", () => {
    expect(errorReason(op("Library/a/b").error)).toBe("operation not permitted");
    expect(errorReason("cannot create iterator")).toBe("cannot create iterator");
    expect(errorReason("")).toBe("unknown error");
  });

  it("uses the innermost cause in a wrapped chain", () => {
    expect(
      errorReason("cannot create iterator: unable to read directory: open /Users/me/x/y.run: permission denied"),
    ).toBe("permission denied");
  });

  it("keeps reasons that contain a slash", () => {
    expect(errorReason("cannot create iterator: unable to read directory: open /Users/me/x: input/output error")).toBe(
      "input/output error",
    );
  });

  it("drops paths that contain spaces", () => {
    expect(errorReason("unable to read directory: open /Users/me/Application Support/x y: permission denied")).toBe(
      "permission denied",
    );
  });

  it("falls back to the innermost wrapper when there is no OS reason", () => {
    expect(errorReason("cannot create iterator: unable to read directory")).toBe("unable to read directory");
    expect(errorReason("error: unable to read directory: /Users/me/dir")).toBe("unable to read directory");
  });

  it("returns the whole message if every segment looks like a path", () => {
    expect(errorReason("/Users/me/dir")).toBe("/Users/me/dir");
  });
});

describe("groupFailures", () => {
  const errors = [
    ...Array.from({ length: 12 }, (_, i) => op(`Library/Accounts/db/file${i}`)),
    pd("Library/Group Containers/g.com.apple.CoreSpeech/Caches/x.bnnsir"),
    pd("Library/Group Containers/g.com.apple.CoreSpeech/Caches/y.bnnsir"),
    pd("Library/Group Containers/g.com.apple.other/z.plist"),
  ];

  it("groups identical causes under the same part of the tree, largest first", () => {
    const g = groupFailures(errors);
    expect(g[0]).toMatchObject({ reason: "operation not permitted", count: 12, label: "Library/Accounts/db" });
    expect(g[1]).toMatchObject({ reason: "permission denied", count: 2 });
    expect(g[1].label).toBe("Library/Group Containers/g.com.apple.CoreSpeech/Caches");
  });

  it("keeps a lone error as its full path", () => {
    const g = groupFailures(errors);
    expect(g[2]).toMatchObject({ count: 1, label: "Library/Group Containers/g.com.apple.other/z.plist" });
  });

  it("does not merge different causes in the same directory", () => {
    const g = groupFailures([op("Library/x/a"), pd("Library/x/b")]);
    expect(g).toHaveLength(2);
  });
});

describe("grouped dialog", () => {
  it("shows a summary line and expands to the individual paths on click", () => {
    const withMany = {
      numFailed: 3,
      errors: [op("Library/Accounts/a"), op("Library/Accounts/b"), op("Library/Accounts/c")],
    };
    render(<div>{sizeWithFailures(1, withMany, false)}<FailuresModalHost /></div>);
    fireEvent.click(screen.getByTestId("show-snapshot-errors"));

    const group = screen.getByTestId("failure-group");
    expect(group).toHaveTextContent(/operation not permitted: ▸ Library\/Accounts \(3\)/);
    // only the target is the link; the cause and count are plain text
    expect(group.querySelector("button")).toHaveTextContent("Library/Accounts");
    expect(group.querySelector("button")).not.toHaveTextContent("operation not permitted");
    expect(group.querySelector("button")).not.toHaveTextContent("(3)");
    expect(screen.queryByText("Library/Accounts/b")).toBeNull();

    fireEvent.click(group.querySelector("button"));
    expect(screen.getByText("Library/Accounts/a")).toBeInTheDocument();
    expect(screen.getByText("Library/Accounts/c")).toBeInTheDocument();
  });
});
