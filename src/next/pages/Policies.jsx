import React, { useState } from "react";
import { includesText } from "../format";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link } from "react-router";
import { policyEditorURL } from "../../utils/policyutil";
import { api } from "../api";
import { useLoad } from "../hooks";
import { SECTIONS } from "../policy/fields";
import { hasValue } from "../policy/helpers";
import { ownerName } from "../snapshots";
import { CliCommand, DataTable, Loaded, Page, SearchBox, StatusBadge, Toolbar } from "../ui";

const VIEWS = [
  ["applicable", "Policies that apply here"],
  ["local", "This user's folders"],
  ["all", "All policies"],
  ["global", "Global policy"],
  ["users", "Per-user policies"],
  ["hosts", "Per-host policies"],
];

// A few policy sections have no editor tab yet, so they can't borrow a label from SECTIONS below.
const SECTIONS_WITHOUT_A_TAB_YET = {
  metadataCompression: "Metadata compression",
  splitter: "Splitter",
  osSnapshots: "OS snapshots",
};

// The label the policy editor itself uses for each section, keyed by that section's own field, so renaming a
// tab there keeps this in sync instead of drifting into a second hand-written list.
const SECTION_LABELS = SECTIONS.reduce((out, s) => {
  const key = s.fields[0]?.path.split(".")[0];
  return key ? { ...out, [key]: s.label } : out;
}, SECTIONS_WITHOUT_A_TAB_YET);

function describe(t) {
  if (!t.host && !t.userName) {
    return "Global";
  }
  if (!t.userName) {
    return "Host " + t.host;
  }
  if (!t.path) {
    return "User " + ownerName(t);
  }
  return t.path;
}

/** Which sections of a policy have anything set, by their editor label. */
function definedSections(policy) {
  return Object.entries(policy || {})
    .filter(([, v]) => hasValue(v))
    .map(([k]) => SECTION_LABELS[k] ?? k);
}

export function Policies() {
  const state = useLoad(
    () =>
      Promise.all([api.get("/api/v1/policies"), api.get("/api/v1/sources")]).then(([p, s]) => ({
        policies: p.data.policies,
        sources: s.data,
      })),
    [],
  );
  const [view, setView] = useState("applicable");
  const [filter, setFilter] = useState("");

  return (
    <Page
      title="Policies"
      subtitle="The most specific policy wins."
      actions={
        <Button as={Link} variant="primary" to="/policies/edit" data-testid="add-policy">
          Add policy
        </Button>
      }
    >
      <Loaded state={state}>
        {({ policies, sources }) => {
          const me = sources.localUsername + "@" + sources.localHost;
          const isGlobal = (t) => !t.userName && !t.host && !t.path;
          const isMyHost = (t) => !t.userName && t.host === sources.localHost && !t.path;
          const pick = {
            applicable: (t) => ownerName(t) === me || isMyHost(t) || isGlobal(t),
            local: (t) => ownerName(t) === me,
            all: () => true,
            global: isGlobal,
            users: (t) => !!t.userName && !!t.host && !t.path,
            hosts: (t) => !t.userName && !!t.host && !t.path,
          }[view];

          const rows = policies.filter((p) => pick(p.target) && includesText(describe(p.target), filter));

          return (
            <>
              <Toolbar>
                <Toolbar.Group label="Show" nowrap>
                  <Form.Select size="sm" aria-label="Show" value={view} onChange={(e) => setView(e.target.value)}>
                    {VIEWS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Form.Select>
                  <SearchBox
                    value={filter}
                    onChange={setFilter}
                    placeholder="Filter by path, user or host"
                    label="Filter policies"
                  />
                </Toolbar.Group>
              </Toolbar>
              <DataTable
                label="policies"
                data={rows}
                getRowId={(p) => p.id}
                initialSort={{ id: "applies", desc: false }}
                emptyText="No policies match."
                columns={[
                  {
                    id: "applies",
                    header: "Applies to",
                    accessor: (p) => describe(p.target),
                    cell: (p) =>
                      p.target.path ? <span className="nx-path">{p.target.path}</span> : describe(p.target),
                  },
                  {
                    id: "owner",
                    header: "User",
                    accessor: (p) => (p.target.userName ? ownerName(p.target) : "everyone"),
                  },
                  {
                    id: "defined",
                    header: "Sets",
                    cell: (p) => (
                      <span className="nx-inline">
                        {definedSections(p.policy).map((s) => (
                          <StatusBadge key={s} kind="neutral">
                            {s}
                          </StatusBadge>
                        ))}
                      </span>
                    ),
                  },
                  {
                    id: "edit",
                    header: "",
                    align: "end",
                    cell: (p) => (
                      <Button
                        as={Link}
                        size="sm"
                        variant="secondary"
                        to={policyEditorURL(p.target)}
                        data-testid="edit-policy"
                      >
                        Edit
                      </Button>
                    ),
                  },
                ]}
              />
              <CliCommand command="policy list" />
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}
