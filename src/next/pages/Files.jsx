import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import ProgressBar from "react-bootstrap/ProgressBar";
import Spinner from "react-bootstrap/Spinner";
import { errorMessage } from "../api";
import { formatDate, formatDateTime } from "../format";
import {
  availableRanges,
  cancelSearch,
  dateInputValue,
  formatSeenRange,
  loadSearch,
  loadSearchRange,
  resultLinks,
  searchRange,
  startSearch,
} from "../search";
import { useLoad } from "../hooks";
import { CountText, DataTable, EmptyState, Field, FromLink, Notice, Page, Panel, PathText, SizeText } from "../ui";

const SEARCH_ID_KEY = "nextSearchId";
const SEARCH_FORM_KEY = "nextSearchForm";

function savedForm() {
  try {
    return JSON.parse(sessionStorage.getItem(SEARCH_FORM_KEY)) || {};
  } catch {
    return {};
  }
}

function remember(key, value) {
  try {
    if (value === null) {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  } catch {
    /* the page works without it */
  }
}

function Available({ avail }) {
  if (!avail) {
    return null;
  }
  if (avail.count === 0) {
    return <EmptyState>There are no snapshots to search yet.</EmptyState>;
  }
  const rows = [
    ...(avail.sources.length > 1
      ? [{ source: "all", path: "All sources", first: avail.first, last: avail.last, count: avail.count }]
      : []),
    ...avail.sources,
  ];

  return (
    <DataTable
      label="available snapshots"
      data={rows}
      getRowId={(r) => r.source}
      footer={false}
      columns={[
        { id: "path", header: "Source", cell: (r) => <PathText>{r.path}</PathText> },
        { id: "first", header: "From", cell: (r) => formatDate(r.first) },
        { id: "last", header: "To", cell: (r) => formatDate(r.last) },
        { id: "count", header: "Snapshots", align: "end", cell: (r) => <CountText n={r.count} /> },
      ]}
    />
  );
}

export function Files() {
  const saved = useRef(savedForm()).current;
  const [pattern, setPattern] = useState(saved.pattern || "");
  const [range, setRange] = useState(saved.range || "30");
  const [from, setFrom] = useState(saved.from || "");
  const [to, setTo] = useState(saved.to || "");
  const [includeDirs, setIncludeDirs] = useState(!!saved.includeDirs);
  const [searchId, setSearchId] = useState(() => {
    try {
      return sessionStorage.getItem(SEARCH_ID_KEY);
    } catch {
      return null;
    }
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const availState = useLoad(loadSearchRange, []);
  const avail = availState.data ?? null;

  useEffect(
    () => remember(SEARCH_FORM_KEY, { pattern, range, from, to, includeDirs }),
    [pattern, range, from, to, includeDirs],
  );

  const forget = useCallback(() => {
    remember(SEARCH_ID_KEY, null);
    setSearchId(null);
    setStatus(null);
  }, []);

  // a search the server no longer knows (it was restarted) is dropped
  const refresh = useCallback(() => {
    if (searchId) {
      loadSearch(searchId).then(setStatus, forget);
    }
  }, [searchId, forget]);

  useEffect(() => {
    if (searchId) {
      loadSearch(searchId).then(setStatus, forget);
    }
  }, [searchId, forget]);

  const running = !!status?.running;

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const t = window.setInterval(refresh, 1000);
    return () => window.clearInterval(t);
  }, [running, refresh]);

  const ranges = availableRanges(avail);
  const rangeValue = ranges.some((r) => r.value === range) ? range : "all";

  const start = (e) => {
    e.preventDefault();
    if (!pattern.trim()) {
      return;
    }
    setStarting(true);
    setError("");
    startSearch({ pattern, includeDirs, ...searchRange(rangeValue, from, to) })
      .then((r) => {
        remember(SEARCH_ID_KEY, r.id);
        setStatus(null);
        setSearchId(r.id);
      })
      .catch((err) => setError("Unable to start the search: " + errorMessage(err)))
      .finally(() => setStarting(false));
  };

  const clear = () => {
    if (searchId) {
      cancelSearch(searchId).catch(() => {});
    }
    forget();
  };

  const results = useMemo(() => status?.results || [], [status]);
  const manySources = new Set(results.map((r) => r.source)).size > 1;
  const p = status?.progress;
  const dateLimits = avail?.count ? { min: dateInputValue(avail.first), max: dateInputValue(avail.last) } : {};

  const columns = [
    {
      id: "name",
      header: "Name",
      accessor: (r) => r.path,
      cell: (r) => (
        <span data-testid="result-path" title={r.path}>
          <PathText dir={r.isDir}>{r.path}</PathText>
        </span>
      ),
    },
    {
      id: "size",
      header: "Size",
      align: "end",
      accessor: (r) => (r.isDir ? -1 : r.size),
      cell: (r) => (r.isDir ? "" : <SizeText bytes={r.size} />),
    },
    { id: "modified", header: "Modified", accessor: (r) => r.modTime, cell: (r) => formatDateTime(r.modTime) },
    {
      id: "seen",
      header: "In snapshots",
      accessor: (r) => r.lastSeen,
      cell: (r) => <span data-testid="seen-range">{formatSeenRange(r.firstSeen, r.lastSeen)}</span>,
    },
    ...(manySources
      ? [{ id: "source", header: "Source", accessor: (r) => r.source, cell: (r) => <PathText>{r.source}</PathText> }]
      : []),
    {
      id: "actions",
      header: "",
      align: "end",
      cell: (r) => {
        const l = resultLinks(r);
        return (
          <span className="nx-inline">
            {l.viewIsPage ? (
              <Button
                as={FromLink}
                size="sm"
                variant="secondary"
                to={l.view}
                state={{ label: r.name }}
                data-testid="view-result"
              >
                Browse
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                href={l.view}
                target="_blank"
                rel="noreferrer"
                data-testid="view-result"
              >
                View
              </Button>
            )}
            <Button
              as={FromLink}
              size="sm"
              variant="primary"
              to={l.restore}
              state={{ label: r.name }}
              data-testid="restore-result"
            >
              Restore
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <Page title="Files">
      <div className="nx-columns">
        <div>
          <Panel title="Search">
            <Form onSubmit={start} data-testid="search-form">
              <Field label="File or folder name">
                {(id) => (
                  <Form.Control
                    id={id}
                    data-testid="search-pattern"
                    placeholder="x.txt   *.xls   report*   Documents/*.docx"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                  />
                )}
              </Field>
              <div className="nx-row">
                <Field label="Snapshots from">
                  {(id) => (
                    <Form.Select
                      id={id}
                      data-testid="search-range"
                      value={rangeValue}
                      onChange={(e) => setRange(e.target.value)}
                    >
                      {ranges.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </Form.Select>
                  )}
                </Field>
                {rangeValue === "custom" && (
                  <>
                    <Field label="From">
                      {(id) => (
                        <Form.Control
                          id={id}
                          type="date"
                          data-testid="search-from"
                          {...dateLimits}
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                        />
                      )}
                    </Field>
                    <Field label="To">
                      {(id) => (
                        <Form.Control
                          id={id}
                          type="date"
                          data-testid="search-to"
                          {...dateLimits}
                          value={to}
                          onChange={(e) => setTo(e.target.value)}
                        />
                      )}
                    </Field>
                  </>
                )}
                <Form.Check
                  type="checkbox"
                  id="search-dirs"
                  label="Also match folder names"
                  checked={includeDirs}
                  onChange={(e) => setIncludeDirs(e.target.checked)}
                />
                <span className="nx-end">
                  {running ? (
                    <Button
                      variant="secondary"
                      onClick={() => cancelSearch(searchId).then(refresh)}
                      data-testid="cancel-search"
                    >
                      Cancel
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={starting || !pattern.trim()}
                      data-testid="start-search"
                    >
                      Search
                    </Button>
                  )}
                </span>
              </div>
              <details className="small nx-muted" data-testid="search-tips">
                <summary>Search tips</summary>
                <ul>
                  <li>
                    <code>*</code> matches any characters and <code>?</code> one character: <code>report*</code>,{" "}
                    <code>*.xls</code>.
                  </li>
                  <li>A name without wildcards must match exactly. Case is ignored.</li>
                  <li>
                    Add a <code>/</code> to match the whole path, for example <code>Documents/*.xls</code>.
                  </li>
                  <li>Each row is one version of a file: the same content at the same path.</li>
                  <li>&quot;In snapshots&quot; is the first and last snapshot date that contains that version.</li>
                </ul>
              </details>
            </Form>
          </Panel>
        </div>
        <div>
          <Panel title="Snapshots available" flush data-testid="available-snapshots">
            <Available avail={avail} />
          </Panel>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      {status && p && (
        <div data-testid="search-progress">
          {running ? (
            <>
              <Spinner animation="border" size="sm" /> Searching: snapshot {p.snapshotsDone} of {p.snapshotsTotal},{" "}
              {p.directories.toLocaleString("en-US")} folders read, {results.length.toLocaleString("en-US")} found
              <ProgressBar
                now={p.snapshotsTotal ? (100 * p.snapshotsDone) / p.snapshotsTotal : 0}
                style={{ height: 6 }}
              />
            </>
          ) : (
            <>
              {status.canceled ? "Search canceled. " : ""}
              {results.length.toLocaleString("en-US")} {results.length === 1 ? "result" : "results"} in{" "}
              {p.snapshotsDone} of {p.snapshotsTotal} snapshots ({p.directories.toLocaleString("en-US")} folders read).{" "}
              <Button size="sm" variant="secondary" onClick={clear} data-testid="clear-results">
                Clear
              </Button>
            </>
          )}
        </div>
      )}
      {status?.error && <Notice kind="error">{status.error}</Notice>}
      {status?.truncated && (
        <Notice kind="warning">
          Too many matches, showing the first {results.length.toLocaleString("en-US")}. Narrow the name or the date
          range.
        </Notice>
      )}
      {status && !running && results.length === 0 && !status.error && (
        <Notice kind="info" data-testid="no-results">
          No matches in the selected snapshots.
        </Notice>
      )}

      {results.length > 0 && (
        <DataTable
          label="search results"
          data={results}
          columns={columns}
          getRowId={(r) => r.source + "|" + r.path + "|" + r.objectId}
          initialSort={{ id: "name", desc: false }}
          data-testid="search-results"
        />
      )}
    </Page>
  );
}
