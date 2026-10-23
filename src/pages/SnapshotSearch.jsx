import axios from "axios";
import { use, useCallback, useEffect, useRef, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Col from "react-bootstrap/Col";
import Form from "react-bootstrap/Form";
import ProgressBar from "react-bootstrap/ProgressBar";
import Row from "react-bootstrap/Row";
import Spinner from "react-bootstrap/Spinner";
import Table from "react-bootstrap/Table";
import { UIPreferencesContext } from "../contexts/UIPreferencesContext";
import { sizeDisplayName } from "../utils/formatutils";
import { errorAlert } from "../utils/uiutil";

const SEARCH_ID_KEY = "snapshotSearchId";
const SEARCH_FORM_KEY = "snapshotSearchForm";

const DAY_MS = 24 * 3600 * 1000;
const DAY_PRESETS = [5, 30, 60, 90];

/**
 * Builds the time range of snapshots to search from the form.
 */
export function searchRange(range, from, to, now = new Date()) {
  if (range === "all") {
    return {};
  }

  if (range === "thisYear") {
    return { from: new Date(now.getFullYear(), 0, 1).toISOString() };
  }

  if (range === "lastYear") {
    return {
      from: new Date(now.getFullYear() - 1, 0, 1).toISOString(),
      to: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999).toISOString(),
    };
  }

  if (range === "custom") {
    const result = {};
    if (from) {
      result.from = new Date(from + "T00:00:00").toISOString();
    }
    if (to) {
      result.to = new Date(to + "T23:59:59.999").toISOString();
    }
    return result;
  }

  return { from: new Date(now.getTime() - Number(range) * DAY_MS).toISOString() };
}

/**
 * Lists the ranges worth offering for the snapshots that exist. A range is left out if no snapshot
 * falls in it, or (for "last N days") if it would add nothing over the shorter one before it.
 * @param {{count: number, first: string, last: string}|null} avail
 */
export function availableRanges(avail, now = new Date()) {
  const ranges = [];

  if (avail && avail.count > 0) {
    const first = new Date(avail.first).getTime();
    const last = new Date(avail.last).getTime();
    let previousStart = Infinity;

    for (const d of DAY_PRESETS) {
      const start = now.getTime() - d * DAY_MS;
      if (start <= last && (ranges.length === 0 || first < previousStart)) {
        ranges.push({ value: String(d), label: "Last " + d + " days" });
        previousStart = start;
      }
    }

    const overlaps = (r) =>
      (r.from ? new Date(r.from).getTime() : -Infinity) <= last &&
      (r.to ? new Date(r.to).getTime() : Infinity) >= first;

    if (overlaps(searchRange("thisYear", "", "", now))) {
      ranges.push({ value: "thisYear", label: "This year" });
    }
    if (overlaps(searchRange("lastYear", "", "", now))) {
      ranges.push({ value: "lastYear", label: "Last year" });
    }
  }

  ranges.push({ value: "all", label: "All snapshots" }, { value: "custom", label: "Custom range..." });

  return ranges;
}

/**
 * Formats when a version of a file was present: "4/3/2024 - 10/20/2026", or a single date.
 */
export function formatSeenRange(firstSeen, lastSeen) {
  const a = new Date(firstSeen).toLocaleDateString();
  const b = new Date(lastSeen).toLocaleDateString();
  return a === b ? a : a + " - " + b;
}

// yyyy-mm-dd in local time, as used by date inputs
function dateInputValue(iso) {
  const d = new Date(iso);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

function loadSavedForm() {
  try {
    return JSON.parse(sessionStorage.getItem(SEARCH_FORM_KEY)) || {};
  } catch {
    return {};
  }
}

// The folder part of a path is shortened with "..." when space is short; the file name stays visible.
function PathCell({ path, isDir }) {
  const i = path.lastIndexOf("/");
  const dir = i >= 0 ? path.slice(0, i + 1) : "";
  const name = i >= 0 ? path.slice(i + 1) : path;
  const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  return (
    <div title={path} style={{ display: "flex", minWidth: 0 }} data-testid="result-path">
      {isDir && <span className="me-1">📁</span>}
      {dir && (
        <span className="text-muted" style={{ ...ellipsis, flex: "0 1000 auto" }}>
          {dir}
        </span>
      )}
      <span style={{ ...ellipsis, flex: "0 0 auto", maxWidth: "100%" }}>{name}</span>
    </div>
  );
}

function ResultActions({ r }) {
  const viewHref = r.isDir
    ? "/snapshots/dir/" + r.objectId
    : "/api/v1/objects/" + r.objectId + "?fname=" + encodeURIComponent(r.name);

  return (
    <>
      <Button size="sm" variant="primary" className="me-1" href={viewHref} data-testid="view-result">
        {r.isDir ? "Browse" : "View"}
      </Button>
      <Button
        size="sm"
        variant="primary"
        href={"/snapshots/dir/" + r.objectId + "/restore"}
        data-testid="restore-result"
      >
        Restore
      </Button>
    </>
  );
}

export function SnapshotSearch() {
  const { bytesStringBase2 } = use(UIPreferencesContext);
  const saved = useRef(loadSavedForm()).current;

  const [pattern, setPattern] = useState(saved.pattern || "");
  const [range, setRange] = useState(saved.range || "30");
  const [from, setFrom] = useState(saved.from || "");
  const [to, setTo] = useState(saved.to || "");
  const [includeDirs, setIncludeDirs] = useState(!!saved.includeDirs);

  const [avail, setAvail] = useState(null);
  const [searchId, setSearchId] = useState(() => sessionStorage.getItem(SEARCH_ID_KEY));
  const [status, setStatus] = useState(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    try {
      sessionStorage.setItem(SEARCH_FORM_KEY, JSON.stringify({ pattern, range, from, to, includeDirs }));
    } catch {
      /* ignore */
    }
  }, [pattern, range, from, to, includeDirs]);

  // which snapshots exist decides which ranges and dates are offered
  useEffect(() => {
    axios
      .get("/api/v1/search-range")
      .then((result) => setAvail(result.data))
      .catch(() => setAvail(null));
  }, []);

  // Fetches the state of the current search. A search the server no longer knows (it was restarted) is dropped.
  const fetchStatus = useCallback(
    (id, onResult, onGone) =>
      axios
        .get("/api/v1/search/" + id)
        .then((result) => onResult(result.data))
        .catch(() => onGone()),
    [],
  );

  const forgetSearch = useCallback(() => {
    sessionStorage.removeItem(SEARCH_ID_KEY);
    setSearchId(null);
    setStatus(null);
  }, []);

  const refresh = useCallback(() => {
    if (searchId) {
      fetchStatus(searchId, setStatus, forgetSearch);
    }
  }, [searchId, fetchStatus, forgetSearch]);

  // pick up a search that is already known (also after leaving and returning to this page)
  useEffect(() => {
    if (searchId) {
      fetchStatus(searchId, setStatus, forgetSearch);
    }
  }, [searchId, fetchStatus, forgetSearch]);

  const ranges = availableRanges(avail);
  const rangeValue = ranges.some((r) => r.value === range) ? range : "all";

  const running = !!status?.running;

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const t = window.setInterval(refresh, 1000);
    return () => window.clearInterval(t);
  }, [running, refresh]);

  const start = (e) => {
    e.preventDefault();
    if (!pattern.trim()) {
      return;
    }

    setStarting(true);
    axios
      .post("/api/v1/search", { pattern, includeDirs, ...searchRange(rangeValue, from, to) })
      .then((result) => {
        sessionStorage.setItem(SEARCH_ID_KEY, result.data.id);
        setStatus(null);
        setSearchId(result.data.id);
      })
      .catch((err) => errorAlert(err, "Unable to start search"))
      .finally(() => setStarting(false));
  };

  const cancel = () => {
    axios.delete("/api/v1/search/" + searchId).then(refresh);
  };

  // clears the results from the page (and lets the server drop them); the search form is left as it is
  const clearResults = () => {
    if (searchId) {
      axios.delete("/api/v1/search/" + searchId).catch(() => {
        /* the server may already have forgotten it */
      });
    }
    forgetSearch();
  };

  const results = status?.results || [];
  const sources = new Set(results.map((r) => r.source));
  const p = status?.progress;

  return (
    <>
      <Row className="g-4">
        <Col lg={7}>
          <Form onSubmit={start} data-testid="search-form">
            <Form.Group className="mb-3" controlId="search-pattern">
              <Form.Label>File or folder name</Form.Label>
              <Form.Control
                size="sm"
                data-testid="search-pattern"
                placeholder="x.txt   *.xls   report*   Documents/*.docx"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
            </Form.Group>

            <Row className="g-2 align-items-end">
              <Col xs="auto">
                <Form.Label htmlFor="search-range">Snapshots from</Form.Label>
                <Form.Select
                  id="search-range"
                  size="sm"
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
              </Col>
              {rangeValue === "custom" && (
                <>
                  <Col xs="auto">
                    <Form.Label htmlFor="search-from">From</Form.Label>
                    <Form.Control
                      id="search-from"
                      size="sm"
                      type="date"
                      data-testid="search-from"
                      min={avail?.count ? dateInputValue(avail.first) : undefined}
                      max={avail?.count ? dateInputValue(avail.last) : undefined}
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </Col>
                  <Col xs="auto">
                    <Form.Label htmlFor="search-to">To</Form.Label>
                    <Form.Control
                      id="search-to"
                      size="sm"
                      type="date"
                      data-testid="search-to"
                      min={avail?.count ? dateInputValue(avail.first) : undefined}
                      max={avail?.count ? dateInputValue(avail.last) : undefined}
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </Col>
                </>
              )}
              <Col xs="auto" className="pb-1">
                <Form.Check
                  type="checkbox"
                  id="search-dirs"
                  label="Also match folder names"
                  checked={includeDirs}
                  onChange={(e) => setIncludeDirs(e.target.checked)}
                />
              </Col>
              <Col xs="auto" className="ms-auto">
                {running ? (
                  <Button size="sm" variant="warning" onClick={cancel} data-testid="cancel-search">
                    Cancel
                  </Button>
                ) : (
                  <Button size="sm" type="submit" variant="primary" disabled={starting} data-testid="start-search">
                    Search
                  </Button>
                )}
              </Col>
            </Row>

            <details className="mt-3 small text-muted" data-testid="search-tips">
              <summary>Search tips</summary>
              <ul className="mt-2 mb-0">
                <li>
                  <code>*</code> matches any characters and <code>?</code> one character. <code>report*</code>,{" "}
                  <code>*.xls</code>
                </li>
                <li>A name without wildcards must match exactly. Case is ignored.</li>
                <li>
                  Add a <code>/</code> to match the whole path, e.g. <code>Documents/*.xls</code>.
                </li>
                <li>Each row is one version of a file: the same content at the same path.</li>
                <li>&quot;In snapshots&quot; is the first and last snapshot date that contains that version.</li>
              </ul>
            </details>
          </Form>
        </Col>

        <Col lg={5}>
          {avail && (
            <Card body className="small" data-testid="available-snapshots">
              <div className="fw-semibold mb-2">Snapshots available</div>
              {avail.count > 0 ? (
                <Table size="sm" borderless className="mb-0">
                  <thead className="text-muted">
                    <tr>
                      <th>Source</th>
                      <th>From</th>
                      <th>To</th>
                      <th className="text-end">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {avail.sources.length > 1 && (
                      <tr className="fw-semibold" data-testid="available-all">
                        <td>All sources</td>
                        <td>{new Date(avail.first).toLocaleDateString()}</td>
                        <td>{new Date(avail.last).toLocaleDateString()}</td>
                        <td className="text-end">{avail.count.toLocaleString()}</td>
                      </tr>
                    )}
                    {avail.sources.map((src) => (
                      <tr key={src.source} data-testid="available-source">
                        <td className="text-break">{src.path}</td>
                        <td>{new Date(src.first).toLocaleDateString()}</td>
                        <td>{new Date(src.last).toLocaleDateString()}</td>
                        <td className="text-end">{src.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <span className="text-muted">There are no snapshots to search yet.</span>
              )}
            </Card>
          )}
        </Col>
      </Row>

      {status && (
        <div className="mt-3" data-testid="search-progress">
          {running ? (
            <>
              <Spinner animation="border" size="sm" /> Searching... snapshot {p.snapshotsDone} of {p.snapshotsTotal}
              {" · "}
              {p.directories.toLocaleString()} folders read{" · "}
              {results.length.toLocaleString()} found
              <ProgressBar
                className="mt-1"
                now={p.snapshotsTotal ? (100 * p.snapshotsDone) / p.snapshotsTotal : 0}
                style={{ height: 6 }}
              />
            </>
          ) : (
            <span>
              {status.canceled ? "Search canceled. " : ""}
              {results.length.toLocaleString()} {results.length === 1 ? "result" : "results"} in {p.snapshotsDone} of{" "}
              {p.snapshotsTotal} snapshots ({p.directories.toLocaleString()} folders read).
            </span>
          )}
          {!running && (
            <Button size="sm" variant="secondary" className="ms-3" onClick={clearResults} data-testid="clear-results">
              Clear
            </Button>
          )}
        </div>
      )}

      {status?.error && (
        <Alert variant="danger" className="mt-3">
          {status.error}
        </Alert>
      )}
      {status?.truncated && (
        <Alert variant="warning" className="mt-3">
          Too many matches, showing the first {results.length.toLocaleString()}. Narrow the name or the date range.
        </Alert>
      )}

      {status && !running && results.length === 0 && !status.error && (
        <Alert variant="info" className="mt-3" data-testid="no-results">
          No matches in the selected snapshots.
        </Alert>
      )}

      {results.length > 0 && (
        <Table
          size="sm"
          hover
          className="mt-3 align-middle"
          data-testid="search-results"
          style={{ tableLayout: "fixed", width: "100%" }}
        >
          <colgroup>
            <col />
            <col style={{ width: 85 }} />
            <col style={{ width: 185 }} />
            <col style={{ width: 205 }} />
            {sources.size > 1 && <col style={{ width: 200 }} />}
            <col style={{ width: 150 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th>In snapshots</th>
              {sources.size > 1 && <th>Source</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.source + "|" + r.path + "|" + r.objectId} data-testid="search-result">
                <td className="pe-3">
                  <PathCell path={r.path} isDir={r.isDir} />
                </td>
                <td className="text-nowrap">{r.isDir ? "" : sizeDisplayName(r.size, bytesStringBase2)}</td>
                <td className="text-nowrap">{new Date(r.modTime).toLocaleString()}</td>
                <td className="text-nowrap" data-testid="seen-range">
                  {formatSeenRange(r.firstSeen, r.lastSeen)}
                </td>
                {sources.size > 1 && (
                  <td className="text-nowrap" title={r.source} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.source}
                  </td>
                )}
                <td className="text-nowrap">
                  <ResultActions r={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
