import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";
import React from "react";
import { PolicyEditor } from "../../src/components/policy-editor/PolicyEditor";
import { MemoryRouter } from "react-router";
import { setupAPIMock } from "../testutils/api-mocks";
import moment from "moment";
import { fireEvent } from "@testing-library/react";

// Mockup for the server
let serverMock;
let ref;

// Initialize the server mock before each test
beforeEach(() => {
  serverMock = setupAPIMock();
  ref = React.createRef();
});

it("e2e", async () => {
  const ust1 = "2021-01-01T12:00:00Z";
  const ust2 = "2021-01-01T13:00:00Z";

  // first request from client - will fetch current policy
  serverMock.onGet("/api/v1/policy?userName=some-user&host=some-host&path=some-path").reply(200, {
    retention: {
      keepLatest: 33,
    },
  });

  // second request to resolve the policy.
  serverMock
    .onPost("/api/v1/policy/resolve?userName=some-user&host=some-host&path=some-path", {
      updates: {
        retention: {
          keepLatest: 33,
        },
      },
      numUpcomingSnapshotTimes: 5,
    })
    .reply(200, {
      effective: {
        retention: {
          keepLatest: 33,
          keepHourly: 45,
        },
      },
      definition: {
        retention: {
          keepLatest: { host: "h1", userName: "some-user", path: "some-path" },
          keepMonthly: { host: "h1", userName: "u1", path: "p1" },
        },
      },
      upcomingSnapshotTimes: [ust1, ust2],
    });

  // second request to resolve the policy.
  serverMock
    .onPost("/api/v1/policy/resolve?userName=some-user&host=some-host&path=some-path", {
      updates: {
        retention: {
          keepLatest: 44,
        },
      },
      numUpcomingSnapshotTimes: 5,
    })
    .reply(200, {
      effective: {
        retention: {
          keepLatest: 44,
          keepHourly: 45,
        },
      },
      definition: {
        retention: {
          keepLatest: {
            host: "some-host",
            userName: "some-user",
            path: "some-path",
          },
          keepMonthly: { host: "h1", userName: "u1", path: "p1" },
        },
      },
      upcomingSnapshotTimes: [ust1, ust2],
    });

  // request to save updated policy.
  serverMock
    .onPut("/api/v1/policy?userName=some-user&host=some-host&path=some-path", {
      retention: {
        keepLatest: 44,
      },
    })
    .reply(200, {
      effective: {
        retention: {
          keepLatest: 33,
          keepHourly: 45,
        },
      },
      definition: {
        retention: {
          keepLatest: { host: "h1", userName: "some-user", path: "some-path" },
          keepMonthly: { host: "h1", userName: "u1", path: "p1" },
        },
      },
      upcomingSnapshotTimes: [ust1, ust2],
    });

  let closeCalled = 0;

  function closeFunc() {
    closeCalled++;
  }

  const { getByTestId } = render(
    <MemoryRouter>
      <PolicyEditor ref={ref} host="some-host" userName="some-user" path="some-path" close={closeFunc} />
    </MemoryRouter>,
  );

  await waitFor(() => expect(getByTestId("effective-retention.keepHourly").value).toBe("45"));
  expect(getByTestId("effective-retention.keepLatest").value).toEqual("33");

  await waitFor(() =>
    expect(getByTestId("definition-retention.keepLatest").innerHTML).toContain(`Directory: some-user@h1:some-path`),
  );
  await waitFor(() =>
    expect(getByTestId("definition-retention.keepMonthly").innerHTML).toContain("Directory: u1@h1:p1"),
  );

  const expectedUpcomingSnapshotTimes = [
    `<li>${moment(ust1).format("L LT")} (${moment(ust1).fromNow()})</li>`,
    `<li>${moment(ust2).format("L LT")} (${moment(ust2).fromNow()})</li>`,
  ].join("");

  await waitFor(() => expect(getByTestId("upcoming-snapshot-times").innerHTML).toEqual(expectedUpcomingSnapshotTimes));

  // change a field
  fireEvent.change(getByTestId("control-policy.retention.keepLatest"), { target: { value: "44" } });

  // this will trigger resolve and will update effective field: "(Defined by this policy)"
  await waitFor(() => expect(getByTestId("effective-retention.keepLatest").value).toBe("44"));
  await waitFor(() =>
    expect(getByTestId("definition-retention.keepLatest").innerHTML).toEqual("(Defined by this policy)"),
  );

  fireEvent.click(getByTestId("button-save"));
  await waitFor(() => expect(serverMock.history.put.length).toEqual(1));
  await waitFor(() => expect(closeCalled).toEqual(1));
});

it("edits the snapshot frequency as a number and a unit, and shows the effective one the same way", async () => {
  const url = "userName=some-user&host=some-host&path=some-path";

  serverMock.onGet("/api/v1/policy?" + url).reply(200, { scheduling: { intervalSeconds: 3600 } });
  serverMock.onPost("/api/v1/policy/resolve?" + url).reply((config) => {
    const seconds = JSON.parse(config.data).updates?.scheduling?.intervalSeconds;
    return [
      200,
      {
        effective: { scheduling: { intervalSeconds: seconds } },
        definition: {
          scheduling: { intervalSeconds: { host: "some-host", userName: "some-user", path: "some-path" } },
        },
        upcomingSnapshotTimes: [],
      },
    ];
  });
  serverMock.onPut("/api/v1/policy?" + url).reply(200, {});

  const { getByTestId, getByLabelText } = render(
    <MemoryRouter>
      <PolicyEditor ref={ref} host="some-host" userName="some-user" path="some-path" close={() => {}} />
    </MemoryRouter>,
  );

  await waitFor(() => expect(getByLabelText("Snapshot frequency value")).toHaveTextContent("1"));
  expect(getByLabelText("Snapshot frequency unit")).toHaveTextContent("hr");
  await waitFor(() => expect(getByTestId("effective-scheduling.intervalSeconds").value).toBe("1 hr"));

  // two selectable parts, not free text: arrows move between them, keys change them
  const value = getByLabelText("Snapshot frequency value");
  const unit = getByLabelText("Snapshot frequency unit");
  value.focus();
  fireEvent.keyDown(value, { key: "9" });
  fireEvent.keyDown(value, { key: "0" });
  fireEvent.keyDown(value, { key: "ArrowRight" });
  expect(unit).toHaveFocus();
  fireEvent.keyDown(unit, { key: "m" });
  fireEvent.blur(unit);

  await waitFor(() => expect(getByTestId("effective-scheduling.intervalSeconds").value).toBe("90 min"));

  fireEvent.click(getByTestId("button-save"));
  await waitFor(() => expect(serverMock.history.put.length).toEqual(1));
  expect(JSON.parse(serverMock.history.put[0].data).scheduling.intervalSeconds).toBe(5400);
});

it("clears the snapshot frequency when the number is erased", async () => {
  const url = "userName=some-user&host=some-host&path=some-path";

  serverMock.onGet("/api/v1/policy?" + url).reply(200, { scheduling: { intervalSeconds: 3600 } });
  serverMock
    .onPost("/api/v1/policy/resolve?" + url)
    .reply(200, { effective: {}, definition: {}, upcomingSnapshotTimes: [] });
  serverMock.onPut("/api/v1/policy?" + url).reply(200, {});

  const { getByTestId, getByLabelText } = render(
    <MemoryRouter>
      <PolicyEditor ref={ref} host="some-host" userName="some-user" path="some-path" close={() => {}} />
    </MemoryRouter>,
  );

  await waitFor(() => expect(getByLabelText("Snapshot frequency value")).toHaveTextContent("1"));

  const value = getByLabelText("Snapshot frequency value");
  fireEvent.keyDown(value, { key: "Backspace" });
  fireEvent.blur(value);
  await waitFor(() => expect(value).toHaveTextContent("—"));

  fireEvent.click(getByTestId("button-save"));
  await waitFor(() => expect(serverMock.history.put.length).toEqual(1));
  expect(JSON.parse(serverMock.history.put[0].data).scheduling?.intervalSeconds).toBeUndefined();
});
