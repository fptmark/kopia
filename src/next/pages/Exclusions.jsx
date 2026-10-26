import React, { useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { errorMessage } from "../api";
import { useLoad } from "../hooks";
import {
  addExclusions,
  describePattern,
  isPathStyle,
  loadExclusions,
  loadNetRules,
  previewExclusions,
  reconcileExclusions,
  removeExclusion,
} from "../exclusions";
import { formatDateTime } from "../format";
import {
  ConfirmDialog,
  CountText,
  DataTable,
  DateTimeText,
  Loaded,
  Notice,
  Page,
  Panel,
  PathText,
  SearchBox,
  SizeText,
  StatusBadge,
  TabNav,
  Toolbar,
} from "../ui";

const ADDED_BY = { manual: "Typed here", compare: "Compare page", failed: "Failed files", import: "Imported" };

function PatternKind({ pattern }) {
  const d = describePattern(pattern);
  return (
    <span title={`Matches ${d.what}${d.anchored ? " starting at the root of the snapshot source" : " at any depth"}`}>
      {d.scope}
      <span className="nx-muted">, {d.foldersOnly ? "folders only" : "files and folders"}</span>
    </span>
  );
}

function AddedCell({ rule }) {
  if (!rule.addedAt) {
    return <span className="nx-muted">before tracking</span>;
  }
  return <DateTimeText value={rule.addedAt} />;
}

/** What a pattern would leave out of the newest snapshot of a source: counts, and the biggest matches. */
function PreviewResult({ result, snapshot }) {
  if (result.error) {
    return <Notice kind="error">{result.error}</Notice>;
  }
  if (result.matches === 0) {
    return (
      <Notice kind="warning">
        <PathText>{result.pattern}</PathText> matches nothing in the newest snapshot
        {snapshot ? ` (${formatDateTime(snapshot.startTime)})` : ""}. Check the spelling, or that it is meant for a
        source that has it.
      </Notice>
    );
  }
  return (
    <div>
      <Notice kind="info">
        <PathText>{result.pattern}</PathText> would leave out {result.matches.toLocaleString("en-US")}{" "}
        {result.matches === 1 ? "item" : "items"}: <CountText n={result.files} /> files,{" "}
        <SizeText bytes={result.bytes} /> in the newest snapshot. Earlier snapshots keep their copies until retention
        removes them.
      </Notice>
      <DataTable
        label="biggest matches"
        data={result.top}
        getRowId={(r) => r.path}
        footer={false}
        columns={[
          {
            id: "path",
            header: "Biggest matches",
            accessor: (r) => r.path,
            cell: (r) => <PathText dir={r.isDir}>{r.path}</PathText>,
          },
          {
            id: "size",
            header: "Size",
            align: "end",
            accessor: (r) => r.size,
            cell: (r) => <SizeText bytes={r.size} />,
          },
          {
            id: "files",
            header: "Files",
            align: "end",
            accessor: (r) => r.files,
            cell: (r) => (r.isDir ? <CountText n={r.files} /> : ""),
          },
        ]}
      />
    </div>
  );
}

/** Pattern box with Check and Add; source is "" for a global rule. */
function AddRule({ source, sources, onAdded, label }) {
  const [pattern, setPattern] = useState("");
  const [against, setAgainst] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);

  const checkSource = source || against || sources[0]?.path || "";
  const trimmed = pattern.trim();

  const check = () => {
    setBusy(true);
    setError("");
    previewExclusions(checkSource, [trimmed])
      .then((r) => setPreview({ result: r.results[0], snapshot: r.snapshot, partial: r.partial }))
      .catch((e) => {
        setPreview(null);
        setError(errorMessage(e));
      })
      .finally(() => setBusy(false));
  };

  const add = (e) => {
    e.preventDefault();
    if (!trimmed) {
      return;
    }
    setBusy(true);
    setError("");
    addExclusions([{ source, pattern: trimmed }], "manual")
      .then((r) => {
        setPattern("");
        setPreview(null);
        onAdded(r, trimmed);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <Form onSubmit={add}>
        <Toolbar>
          <Toolbar.Group label={label} grow>
            <Form.Control
              size="sm"
              className="nx-search"
              placeholder="node_modules/   or   Projects/**/build/   or   *.tmp"
              aria-label="Pattern"
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                setPreview(null);
              }}
            />
            {!source && sources.length > 0 && (
              <Form.Select
                size="sm"
                aria-label="Check against"
                value={against || sources[0].path}
                onChange={(e) => setAgainst(e.target.value)}
              >
                {sources.map((s) => (
                  <option key={s.path} value={s.path}>
                    check against {s.path}
                  </option>
                ))}
              </Form.Select>
            )}
            <Button size="sm" variant="secondary" disabled={!trimmed || busy || !checkSource} onClick={check}>
              Check what it matches
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!trimmed || busy}>
              Add rule
            </Button>
          </Toolbar.Group>
        </Toolbar>
      </Form>
      {trimmed && (
        <div className="nx-help" data-testid="pattern-hint">
          <PatternKind pattern={trimmed} />
          {!source && isPathStyle(trimmed) && (
            <span>
              <StatusBadge kind="warning">path style</StatusBadge> only does anything in sources that have this path
            </span>
          )}
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {preview && (
        <>
          {preview.partial && <Notice kind="warning">Stopped at the time limit; the counts are at least this.</Notice>}
          <PreviewResult result={preview.result} snapshot={preview.snapshot} />
        </>
      )}
    </div>
  );
}

function RulesTable({ rules, showSource, onRemove, emptyText }) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(
    () => rules.filter((r) => (r.pattern + " " + r.source).toLowerCase().includes(filter.trim().toLowerCase())),
    [rules, filter],
  );

  const columns = [
    { id: "pattern", header: "Pattern", accessor: (r) => r.pattern, cell: (r) => <PathText>{r.pattern}</PathText> },
    {
      id: "kind",
      header: "Matches",
      accessor: (r) => describePattern(r.pattern).scope,
      cell: (r) => <PatternKind pattern={r.pattern} />,
    },
    ...(showSource
      ? [
          {
            id: "source",
            header: "Applies to",
            accessor: (r) => r.source || "",
            cell: (r) =>
              r.source ? <PathText>{r.source}</PathText> : <StatusBadge kind="info">Everything</StatusBadge>,
          },
        ]
      : []),
    { id: "added", header: "Added", accessor: (r) => r.addedAt || "", cell: (r) => <AddedCell rule={r} /> },
    { id: "by", header: "How", accessor: (r) => r.addedBy, cell: (r) => ADDED_BY[r.addedBy] ?? r.addedBy },
    {
      id: "remove",
      header: "",
      align: "end",
      cell: (r) => (
        <Button size="sm" variant="secondary" aria-label={"Remove " + r.pattern} onClick={() => onRemove(r)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <>
      <Toolbar>
        <Toolbar.Group label="Filter" grow>
          <SearchBox value={filter} onChange={setFilter} placeholder="Filter rules" />
        </Toolbar.Group>
      </Toolbar>
      <DataTable
        label="rules"
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        initialSort={{ id: "pattern", desc: false }}
        emptyText={emptyText}
      />
    </>
  );
}

function NetRules({ sources }) {
  const [source, setSource] = useState(sources[0]?.path ?? "");
  const state = useLoad(() => loadNetRules(source), [source], { enabled: !!source });

  if (sources.length === 0) {
    return <Notice kind="info">No snapshot sources yet.</Notice>;
  }

  return (
    <>
      <Toolbar>
        <Toolbar.Group label="Source">
          <Form.Select size="sm" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
            {sources.map((s) => (
              <option key={s.path} value={s.path}>
                {s.path}
              </option>
            ))}
          </Form.Select>
        </Toolbar.Group>
        {state.data && (
          <Toolbar.Group label="Kopia">
            {state.data.inSync ? (
              <StatusBadge kind="ok">in force</StatusBadge>
            ) : (
              <StatusBadge
                kind="error"
                title={`${state.data.missing.length} missing, ${state.data.extra.length} extra`}
              >
                differs from these rules
              </StatusBadge>
            )}
          </Toolbar.Group>
        )}
      </Toolbar>
      <Loaded state={state}>
        {(d) => (
          <DataTable
            label="net rules"
            data={d.rules}
            getRowId={(r) => r.pattern}
            initialSort={{ id: "pattern", desc: false }}
            emptyText="Nothing is excluded for this source."
            columns={[
              {
                id: "pattern",
                header: "Pattern",
                accessor: (r) => r.pattern,
                cell: (r) => <PathText>{r.pattern}</PathText>,
              },
              {
                id: "kind",
                header: "Matches",
                accessor: (r) => describePattern(r.pattern).scope,
                cell: (r) => <PatternKind pattern={r.pattern} />,
              },
              {
                id: "from",
                header: "From",
                accessor: (r) => r.from,
                cell: (r) => (
                  <StatusBadge kind={r.from === "source" ? "modified" : "info"}>
                    {r.from === "global" ? "Global" : r.from === "source" ? "This source" : "Both"}
                  </StatusBadge>
                ),
              },
              { id: "added", header: "Added", accessor: (r) => r.addedAt || "", cell: (r) => <AddedCell rule={r} /> },
            ]}
          />
        )}
      </Loaded>
    </>
  );
}

export function Exclusions() {
  const state = useLoad(loadExclusions, []);
  const [tab, setTab] = useState("global");
  const [source, setSource] = useState("");
  const [message, setMessage] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);

  const done = (kind, text) => {
    setMessage({ kind, text });
    state.reload();
  };

  const remove = () => {
    setBusy(true);
    removeExclusion(removing.id)
      .then((r) =>
        done(
          r.applyError ? "warning" : "success",
          r.applyError
            ? `Removed, but Kopia's policy was not updated: ${r.applyError}`
            : `Removed ${removing.pattern}. The next snapshot includes it again.`,
        ),
      )
      .catch((e) => done("error", "Not removed: " + errorMessage(e)))
      .finally(() => {
        setBusy(false);
        setRemoving(null);
      });
  };

  const fix = () => {
    setBusy(true);
    reconcileExclusions()
      .then((r) =>
        done(
          "success",
          `Kopia's policies now follow the rules (${r.changes.length} ${r.changes.length === 1 ? "policy" : "policies"} changed).`,
        ),
      )
      .catch((e) => done("error", "Not fixed: " + errorMessage(e)))
      .finally(() => {
        setBusy(false);
        setFixing(false);
      });
  };

  const added = (r, pattern) => {
    if (r.added.length === 0) {
      done("info", `${pattern} was already a rule.`);
    } else if (r.applyError) {
      done("warning", `Added ${pattern}, but Kopia's policy was not updated: ${r.applyError}`);
    } else {
      done("success", `Added ${pattern}. The next snapshot leaves it out.`);
    }
  };

  return (
    <Page title="Exclusions">
      <Loaded state={state}>
        {(d) => {
          const sources = d.sources;
          const global = d.rules.filter((r) => !r.source);
          const bySource = d.rules.filter((r) => r.source);
          const current = source || sources.find((s) => s.ownRules > 0)?.path || sources[0]?.path || "";
          const shown = bySource.filter((r) => r.source === current);

          return (
            <>
              {d.drift.length > 0 && (
                <Notice kind="warning" title="Kopia does not follow these rules yet.">
                  {d.drift.map((x) => `${x.target}: ${x.missing.length} missing, ${x.extra.length} extra`).join("; ")}.{" "}
                  <Button size="sm" variant="primary" onClick={() => setFixing(true)}>
                    Fix
                  </Button>
                </Notice>
              )}
              {message && (
                <Notice kind={message.kind} onClose={() => setMessage(null)}>
                  {message.text}
                </Notice>
              )}

              <TabNav
                active={tab}
                onChange={setTab}
                tabs={[
                  { id: "global", label: "Global rules", badge: global.length },
                  { id: "source", label: "Source rules", badge: bySource.length },
                  { id: "net", label: "Net rules" },
                  { id: "removed", label: "Removed", badge: d.removed.length || "" },
                ]}
              />

              {tab === "global" && (
                <>
                  <AddRule source="" sources={sources} onAdded={added} label="Add a global rule" />
                  <RulesTable rules={global} onRemove={setRemoving} emptyText="No global rules." />
                </>
              )}

              {tab === "source" && (
                <>
                  <Toolbar>
                    <Toolbar.Group label="Source">
                      <Form.Select
                        size="sm"
                        aria-label="Source"
                        value={current}
                        onChange={(e) => setSource(e.target.value)}
                      >
                        {sources.map((s) => (
                          <option key={s.path} value={s.path}>
                            {s.path}
                          </option>
                        ))}
                      </Form.Select>
                    </Toolbar.Group>
                  </Toolbar>
                  {current && (
                    <AddRule source={current} sources={sources} onAdded={added} label={`Add a rule for ${current}`} />
                  )}
                  <RulesTable rules={shown} onRemove={setRemoving} emptyText="This source has no rules of its own." />
                </>
              )}

              {tab === "net" && (
                <Panel
                  title="Rules that apply to a source"
                  note="global rules and the source's own, together"
                  flush={false}
                >
                  <NetRules sources={sources} />
                </Panel>
              )}

              {tab === "removed" && (
                <DataTable
                  label="removed rules"
                  data={d.removed}
                  getRowId={(r) => r.id + r.removedAt}
                  initialSort={{ id: "removed", desc: true }}
                  emptyText="No rule has been removed."
                  columns={[
                    {
                      id: "pattern",
                      header: "Pattern",
                      accessor: (r) => r.pattern,
                      cell: (r) => <PathText>{r.pattern}</PathText>,
                    },
                    {
                      id: "source",
                      header: "Applied to",
                      accessor: (r) => r.source || "",
                      cell: (r) =>
                        r.source ? <PathText>{r.source}</PathText> : <StatusBadge kind="info">Everything</StatusBadge>,
                    },
                    {
                      id: "added",
                      header: "Added",
                      accessor: (r) => r.addedAt || "",
                      cell: (r) => <AddedCell rule={r} />,
                    },
                    {
                      id: "removed",
                      header: "Removed",
                      accessor: (r) => r.removedAt,
                      cell: (r) => <DateTimeText value={r.removedAt} />,
                    },
                  ]}
                />
              )}

              <ConfirmDialog
                show={!!removing}
                title="Remove this rule?"
                confirmLabel="Remove"
                danger
                busy={busy}
                onCancel={() => setRemoving(null)}
                onConfirm={remove}
              >
                {removing && (
                  <>
                    <PathText>{removing.pattern}</PathText> stops being left out
                    {removing.source ? ` of ${removing.source}` : " of every source"}. The next snapshot includes what
                    it matched.
                  </>
                )}
              </ConfirmDialog>

              <ConfirmDialog
                show={fixing}
                title="Write the rules into Kopia's policies?"
                confirmLabel="Fix"
                busy={busy}
                onCancel={() => setFixing(false)}
                onConfirm={fix}
              >
                <p>These policies change so that Kopia leaves out exactly what the rules say:</p>
                <ul>
                  {d.drift.map((x) => (
                    <li key={x.target}>
                      <b>{x.target}</b>: adds {x.missing.length}, removes {x.extra.length}{" "}
                      {x.extra.length === 1 ? "rule" : "rules"}
                    </li>
                  ))}
                </ul>
                <p>The next snapshot of those sources follows the new lists.</p>
              </ConfirmDialog>
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}
