import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useNavigate } from "react-router";
import { checkPolicyPath, policyEditorURL } from "../../utils/policyutil";
import { api } from "../api";
import { useLoad } from "../hooks";
import { CliCommand, DataTable, Loaded, Notice, Page, SearchBox, StatusBadge, Toolbar } from "../ui";

const VIEWS = [
  ["applicable", "Policies that apply here"],
  ["local", "This user's folders"],
  ["all", "All policies"],
  ["global", "Global policy"],
  ["users", "Per-user policies"],
  ["hosts", "Per-host policies"],
];

const owner = (t) => t.userName + "@" + t.host;

function describe(t) {
  if (!t.host && !t.userName) {
    return "Global";
  }
  if (!t.userName) {
    return "Host " + t.host;
  }
  if (!t.path) {
    return "User " + owner(t);
  }
  return t.path;
}

/** Which sections of a policy have anything set. */
function definedSections(policy) {
  return Object.entries(policy || {})
    .filter(([, v]) => v && typeof v === "object" && Object.keys(v).length > 0)
    .map(([k]) => k);
}

export function Policies() {
  const navigate = useNavigate();
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
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState("");

  const edit = (e, localUser, localHost) => {
    e.preventDefault();
    const error = checkPolicyPath(path);
    if (error) {
      setPathError(error + " Use an absolute path, user@host:/path, user@host or @host.");
      return;
    }
    navigate(policyEditorURL({ userName: localUser, host: localHost, path }));
  };

  return (
    <Page
      title="Policies"
      subtitle="Settings for what is backed up, when and for how long. More specific policies override the ones above them."
    >
      <Loaded state={state}>
        {({ policies, sources }) => {
          const me = sources.localUsername + "@" + sources.localHost;
          const isGlobal = (t) => !t.userName && !t.host && !t.path;
          const isMyHost = (t) => !t.userName && t.host === sources.localHost && !t.path;
          const pick = {
            applicable: (t) => owner(t) === me || isMyHost(t) || isGlobal(t),
            local: (t) => owner(t) === me,
            all: () => true,
            global: isGlobal,
            users: (t) => !!t.userName && !!t.host && !t.path,
            hosts: (t) => !t.userName && !!t.host && !t.path,
          }[view];

          const needle = filter.trim().toLowerCase();
          const rows = policies.filter(
            (p) => pick(p.target) && (!needle || describe(p.target).toLowerCase().includes(needle)),
          );

          return (
            <>
              <Toolbar>
                <Toolbar.Group label="Show">
                  <Form.Select size="sm" aria-label="Show" value={view} onChange={(e) => setView(e.target.value)}>
                    {VIEWS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Form.Select>
                  <SearchBox value={filter} onChange={setFilter} placeholder="Filter" label="Filter policies" />
                </Toolbar.Group>
                <Toolbar.Group label="Folder" grow>
                  <Form
                    className="d-flex gap-2 flex-grow-1"
                    onSubmit={(e) => edit(e, sources.localUsername, sources.localHost)}
                  >
                    <Form.Control
                      size="sm"
                      className="nx-search"
                      aria-label="Folder"
                      placeholder="/path/to/a/folder"
                      value={path}
                      onChange={(e) => {
                        setPath(e.target.value);
                        setPathError("");
                      }}
                    />
                    <Button size="sm" type="submit" variant="primary" disabled={!path}>
                      Set policy
                    </Button>
                  </Form>
                </Toolbar.Group>
              </Toolbar>
              {pathError && <Notice kind="error">{pathError}</Notice>}
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
                  { id: "owner", header: "User", accessor: (p) => (p.target.userName ? owner(p.target) : "everyone") },
                  {
                    id: "defined",
                    header: "Sets",
                    cell: (p) => (
                      <span className="d-inline-flex flex-wrap gap-1">
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
