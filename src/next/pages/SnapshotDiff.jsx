import React, { use, useMemo, useState } from "react";
import Form from "react-bootstrap/Form";
import Button from "react-bootstrap/Button";
import { useLocation } from "react-router";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { errorMessage } from "../api";
import { addExclusions } from "../exclusions";
import { baseName, formatDateTime, formatSizeChange, plural } from "../format";
import { useLoad } from "../hooks";
import { loadDiff } from "../snapshots";
import {
  ConfirmDialog,
  CountText,
  DataTable,
  Loaded,
  Notice,
  Page,
  Panel,
  PathText,
  SearchBox,
  SizeText,
  Stat,
  Stats,
  StatusBadge,
  Toolbar,
} from "../ui";

const KINDS = ["added", "removed", "modified"];

// a folder name is escaped like any other pattern: Kopia reads * ? [ ] and \ as pattern characters
function folderNamePattern(name) {
  return name.replace(/([\\*?[\]])/g, "\\$1") + "/";
}

function exactPattern(path) {
  return "/" + path.replace(/^\/+/, "").replace(/([\\*?[\]])/g, "\\$1");
}

/** What changed between two snapshots of one source, with a way to leave what was added out of future backups. */
export function SnapshotDiff() {
  const location = useLocation();
  const prefs = use(UIPreferencesContext);
  const q = new URLSearchParams(location.search);
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  const state = useLoad(() => loadDiff(from, to), [from, to]);

  const [shown, setShown] = useState({ added: true, removed: true, modified: true });
  const [text, setText] = useState("");
  const [selected, setSelected] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [wide, setWide] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const entries = useMemo(() => state.data?.entries ?? [], [state.data]);
  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return entries.filter((e) => shown[e.change] && (!needle || e.path.toLowerCase().includes(needle)));
  }, [entries, shown, text]);

  const canExclude = (e) => e.change !== "removed";
  const chosen = entries.filter((e) => selected[e.path]);
  const chosenBytes = chosen.reduce((n, e) => n + e.newSize, 0);
  const listed = rows.filter(canExclude);
  const unticked = listed.filter((e) => !selected[e.path]);

  // folders that share a name (node_modules, Caches) can be excluded by name, wherever they are
  const folderNames = {};
  for (const e of chosen) {
    if (e.isDir) {
      const n = baseName(e.path);
      folderNames[n] = (folderNames[n] ?? 0) + 1;
    }
  }
  const byName = (n) => wide[n] ?? folderNames[n] > 1;
  const patterns = [
    ...new Set(
      chosen.map((e) =>
        e.isDir && byName(baseName(e.path)) ? folderNamePattern(baseName(e.path)) : exactPattern(e.path),
      ),
    ),
  ];

  const exclude = () => {
    setBusy(true);
    addExclusions(
      patterns.map((pattern) => ({ source: state.data.source.path, pattern })),
      "compare",
    )
      .then((r) => {
        const n = r.added.length;
        setMessage(
          r.applyError
            ? {
                kind: "warning",
                text: `Added ${plural(n, "rule")}, but Kopia's policy was not updated: ${r.applyError}`,
              }
            : {
                kind: "success",
                text: `Added ${plural(n, "rule")}${r.existing.length ? ` (${r.existing.length} already existed)` : ""}. The next snapshot skips what they match; copies in earlier snapshots stay until retention removes them.`,
              },
        );
        setSelected({});
      })
      .catch((e) => setMessage({ kind: "error", text: "Not changed: " + errorMessage(e) }))
      .finally(() => {
        setBusy(false);
        setConfirming(false);
      });
  };

  const columns = [
    { id: "change", header: "Change", accessor: (e) => e.change, cell: (e) => <StatusBadge kind={e.change} /> },
    {
      id: "path",
      header: () => <span title={"Relative to " + (state.data?.source.path ?? "")}>Path</span>,
      accessor: (e) => e.path,
      cell: (e) => <PathText dir={e.isDir}>{e.path}</PathText>,
    },
    {
      id: "before",
      header: "Before",
      align: "end",
      accessor: (e) => (e.change === "added" ? -1 : e.oldSize),
      cell: (e) => (e.change === "added" ? <span className="nx-muted">{"—"}</span> : <SizeText bytes={e.oldSize} />),
    },
    {
      id: "after",
      header: "After",
      align: "end",
      accessor: (e) => (e.change === "removed" ? -1 : e.newSize),
      cell: (e) => (e.change === "removed" ? <span className="nx-muted">{"—"}</span> : <SizeText bytes={e.newSize} />),
    },
    {
      id: "files",
      header: "Files",
      align: "end",
      accessor: (e) => e.files ?? 0,
      cell: (e) => (e.isDir ? <CountText n={e.files ?? 0} /> : ""),
    },
  ];

  return (
    <Page
      title="Compare snapshots"
      back
      backLabel="History"
      subtitle={
        state.data && (
          <>
            Changes in <span className="nx-path">{state.data.source.path}</span>; paths are relative to it.
          </>
        )
      }
    >
      <Loaded state={state}>
        {(d) => {
          const total = d.added + d.removed + d.modified;
          return (
            <>
              <Panel>
                <Stats data-testid="diff-summary">
                  <Stat
                    label="Before"
                    value={formatDateTime(d.from.startTime)}
                    note={
                      <>
                        <SizeText bytes={d.from.summary?.size} /> logical
                      </>
                    }
                  />
                  <Stat
                    label="After"
                    value={formatDateTime(d.to.startTime)}
                    note={
                      <>
                        <SizeText bytes={d.to.summary?.size} /> logical
                      </>
                    }
                  />
                  {total === 0 ? (
                    <Stat label="Changes" value="None" />
                  ) : (
                    <>
                      <Stat label="Added" value={plural(d.added, "file")} note={<SizeText bytes={d.addedBytes} />} />
                      <Stat
                        label="Removed"
                        value={plural(d.removed, "file")}
                        note={<SizeText bytes={d.removedBytes} />}
                      />
                      <Stat
                        label="Modified"
                        value={plural(d.modified, "file")}
                        note={`${formatSizeChange(d.modifiedDeltaBytes, !!prefs.bytesStringBase2)} net`}
                      />
                    </>
                  )}
                </Stats>
              </Panel>

              {message && (
                <Notice kind={message.kind} onClose={() => setMessage(null)}>
                  {message.text}
                </Notice>
              )}
              {d.truncated && (
                <Notice kind="info" data-testid="diff-truncated">
                  Only the first {entries.length.toLocaleString("en-US")} differences are listed; the totals above count
                  all of them.
                </Notice>
              )}

              <Toolbar>
                <Toolbar.Group label="Show" grow>
                  {KINDS.map((k) => (
                    <Form.Check
                      key={k}
                      inline
                      type="checkbox"
                      id={"show-" + k}
                      className="mb-0"
                      label={k}
                      checked={shown[k]}
                      onChange={() => setShown((cur) => ({ ...cur, [k]: !cur[k] }))}
                    />
                  ))}
                  <SearchBox
                    value={text}
                    onChange={setText}
                    placeholder="Filter by path"
                    label="Filter by path"
                    data-testid="diff-filter"
                  />
                </Toolbar.Group>
                <Toolbar.Group label="Selected" end data-testid="selection-bar">
                  <span className={chosen.length === 0 ? "nx-muted small" : "small"}>
                    {chosen.length === 0 ? (
                      "Nothing selected"
                    ) : (
                      <>
                        {chosen.length} selected (<SizeText bytes={chosenBytes} />)
                      </>
                    )}
                  </span>
                  {chosen.length > 0 && unticked.length > 0 && (
                    <a
                      href="#top"
                      className="small"
                      onClick={(e) => {
                        e.preventDefault();
                        setSelected((cur) => ({ ...cur, ...Object.fromEntries(listed.map((x) => [x.path, true])) }));
                      }}
                    >
                      Select all {listed.length.toLocaleString("en-US")} listed
                    </a>
                  )}
                  {chosen.length > 0 && (
                    <a
                      href="#top"
                      className="small"
                      onClick={(e) => {
                        e.preventDefault();
                        setSelected({});
                      }}
                    >
                      Clear
                    </a>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={chosen.length === 0}
                    onClick={() => setConfirming(true)}
                    data-testid="exclude-selected"
                    title="Stop backing up the ticked paths"
                  >
                    Exclude from backup
                  </Button>
                </Toolbar.Group>
              </Toolbar>

              <DataTable
                label="changes"
                data={rows}
                columns={columns}
                getRowId={(e) => e.path}
                selection={{ selected, onChange: setSelected, isSelectable: canExclude }}
                initialSort={{ id: "after", desc: true }}
                emptyText={total === 0 ? "The two snapshots are the same." : "Nothing matches the filters."}
              />

              <ConfirmDialog
                show={confirming}
                title="Exclude from backup"
                confirmLabel="Exclude"
                danger
                busy={busy}
                onCancel={() => setConfirming(false)}
                onConfirm={exclude}
                data-testid="exclude-dialog"
              >
                <p>
                  Stop backing up {chosen.length === 1 ? "this path" : `these ${chosen.length} paths`} (
                  <SizeText bytes={chosenBytes} />
                  )?
                </p>
                {Object.keys(folderNames).length > 0 && (
                  <div className="mb-2" data-testid="by-name-options">
                    {Object.entries(folderNames).map(([name, count]) => (
                      <Form.Check
                        key={name}
                        type="checkbox"
                        id={"by-name-" + name}
                        checked={byName(name)}
                        onChange={() => setWide((cur) => ({ ...cur, [name]: !byName(name) }))}
                        label={
                          <>
                            Every folder named <code>{name}</code>, wherever it is ({count} selected)
                          </>
                        }
                      />
                    ))}
                  </div>
                )}
                <ul className="small" style={{ maxHeight: "12em", overflowY: "auto", wordBreak: "break-all" }}>
                  {patterns.map((p) => (
                    <li key={p}>
                      <PathText>{p}</PathText>
                    </li>
                  ))}
                </ul>
                {patterns.some((p) => !p.startsWith("/")) && (
                  <p className="small">
                    A pattern without a leading slash matches at any depth, so it also covers folders with that name
                    that are not in the list, and any created later.
                  </p>
                )}
                <p className="small mb-0">
                  These become rules for <PathText>{d.source.path}</PathText>. The next snapshot skips them. Copies
                  already in earlier snapshots stay until retention removes them.
                </p>
              </ConfirmDialog>
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}
