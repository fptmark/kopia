import axios from "axios";
import React, { use, useEffect, useMemo, useState } from "react";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Col from "react-bootstrap/Col";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import Row from "react-bootstrap/Row";
import Spinner from "react-bootstrap/Spinner";
import { useLocation } from "react-router";
import KopiaTable from "../components/KopiaTable";
import { GoBackButton } from "../components/GoBackButton";
import { UIPreferencesContext } from "../contexts/UIPreferencesContext";
import { baseName, excludeFolderNamePattern, excludePattern, excludePatternsFromBackup } from "../utils/ignoredErrors";
import { compactCount, parseQuery, rfc3339TimestampForDisplay, sizeDisplayName } from "../utils/formatutils";

const changeVariant = { added: "success", removed: "danger", modified: "warning" };
const changeKinds = ["added", "removed", "modified"];

// the header and row checkboxes share this box so they line up with each other and with the badges
const checkCell = "d-flex justify-content-center align-items-center";
const checkCellStyle = { height: "1.6em" };

function signed(n, bytesStringBase2) {
  return (n < 0 ? "-" : "+") + sizeDisplayName(Math.abs(n), bytesStringBase2);
}

/**
 * Lists what changed between two snapshots of one source: files and directories that were added,
 * removed or modified. The older snapshot is "from", the newer is "to".
 */
export function SnapshotDiff() {
  const location = useLocation();
  const { bytesStringBase2 } = use(UIPreferencesContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [shown, setShown] = useState({ added: true, removed: true, modified: true });
  const [text, setText] = useState("");
  const [selected, setSelected] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [wide, setWide] = useState({});

  const q = parseQuery(location.search);

  useEffect(() => {
    axios
      .get("/api/v1/snapshots/diff?from=" + encodeURIComponent(q.from) + "&to=" + encodeURIComponent(q.to))
      .then((result) => setData(result.data))
      .catch((e) => setError(e));
  }, [q.from, q.to]);

  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();

    return (data?.entries ?? []).filter((e) => shown[e.change] && (!needle || e.path.toLowerCase().includes(needle)));
  }, [data, shown, text]);

  // only what is in the newer snapshot can still be excluded from future backups
  const canExclude = (e) => e.change !== "removed";
  const chosen = (data?.entries ?? []).filter((e) => selected[e.path]);
  const chosenBytes = chosen.reduce((n, e) => n + e.newSize, 0);

  // folders that share a name (node_modules, Caches) can be excluded by name, wherever they are
  const folderNames = {};
  for (const e of chosen) {
    if (e.isDir) {
      const name = baseName(e.path);
      folderNames[name] = (folderNames[name] ?? 0) + 1;
    }
  }
  const byName = (name) => wide[name] ?? folderNames[name] > 1;
  const patterns = [
    ...new Set(
      chosen.map((e) =>
        e.isDir && byName(baseName(e.path)) ? excludeFolderNamePattern(baseName(e.path)) : excludePattern(e.path),
      ),
    ),
  ];

  const toggle = (path) =>
    setSelected((cur) => {
      const next = { ...cur };
      if (next[path]) {
        delete next[path];
      } else {
        next[path] = true;
      }

      return next;
    });

  const selectPaths = (entries, on) =>
    setSelected((cur) => {
      const next = { ...cur };
      for (const e of entries) {
        if (on) {
          next[e.path] = true;
        } else {
          delete next[e.path];
        }
      }

      return next;
    });

  const exclude = () => {
    setBusy(true);
    excludePatternsFromBackup(data.source, patterns)
      .then((saved) => {
        setResult({ ok: true, count: saved.length });
        setSelected({});
        setConfirming(false);
        setBusy(false);
      })
      .catch((e) => {
        setResult({ ok: false, message: e?.response?.data?.message || e?.message || "unknown error" });
        setConfirming(false);
        setBusy(false);
      });
  };

  if (error) {
    return (
      <>
        <GoBackButton />
        <p className="vpadded">{error.response?.data?.error ?? error.message}</p>
      </>
    );
  }

  if (!data) {
    return <Spinner animation="border" variant="primary" />;
  }

  const columns = [
    {
      id: "selected",
      header: ({ table }) => {
        const page = table
          .getRowModel()
          .rows.map((r) => r.original)
          .filter(canExclude);
        const ticked = page.filter((e) => selected[e.path]).length;

        return (
          <div className={checkCell} style={checkCellStyle}>
            <input
              type="checkbox"
              className="form-check-input m-0"
              aria-label="Select all on this page"
              title="Select or clear every row on this page"
              disabled={page.length === 0}
              checked={page.length > 0 && ticked === page.length}
              ref={(el) => {
                if (el) {
                  el.indeterminate = ticked > 0 && ticked < page.length;
                }
              }}
              onChange={() => selectPaths(page, ticked < page.length)}
            />
          </div>
        );
      },
      width: 20,
      align: "center",
      cell: (x) =>
        canExclude(x.row.original) ? (
          <div className={checkCell} style={checkCellStyle}>
            <input
              type="checkbox"
              className="form-check-input m-0"
              aria-label={"Select " + x.row.original.path}
              checked={!!selected[x.row.original.path]}
              onChange={() => toggle(x.row.original.path)}
            />
          </div>
        ) : null,
    },
    {
      id: "change",
      header: "Change",
      width: 100,
      accessorFn: (x) => x.change,
      cell: (x) => <Badge bg={changeVariant[x.cell.getValue()]}>{x.cell.getValue()}</Badge>,
    },
    {
      id: "path",
      header: () => <span title={"Relative to " + data.source.path}>Path</span>,
      width: "",
      accessorFn: (x) => x.path,
      cell: (x) => (
        <span className="snapshot-hash">
          {x.cell.getValue()}
          {x.row.original.isDir ? "/" : ""}
        </span>
      ),
    },
    {
      id: "oldSize",
      header: "Before",
      width: 110,
      accessorFn: (x) => (x.change === "added" ? -1 : x.oldSize),
      cell: (x) =>
        x.row.original.change === "added" ? "—" : sizeDisplayName(x.row.original.oldSize, bytesStringBase2),
    },
    {
      id: "newSize",
      header: "After",
      width: 110,
      accessorFn: (x) => (x.change === "removed" ? -1 : x.newSize),
      cell: (x) =>
        x.row.original.change === "removed" ? "—" : sizeDisplayName(x.row.original.newSize, bytesStringBase2),
    },
    {
      id: "files",
      header: "Files",
      width: 80,
      accessorFn: (x) => x.files ?? 0,
      cell: (x) => (x.row.original.isDir ? compactCount(x.cell.getValue()) : ""),
    },
  ];

  const total = data.added + data.removed + data.modified;
  const matching = rows.filter(canExclude);
  const unticked = matching.filter((e) => !selected[e.path]);

  const stat = (variant, label, count, size) => (
    <div>
      <Badge bg={variant}>
        {compactCount(count)} {label}
      </Badge>
      <div className="small text-muted mt-1">{size}</div>
    </div>
  );

  return (
    <>
      <Row>
        <Col>
          <GoBackButton />
        </Col>
      </Row>

      <div className="border rounded p-3 my-3" data-testid="diff-header">
        <h5 className="mb-1">Changes between two snapshots</h5>
        <div className="small text-muted mb-3" data-testid="diff-root">
          Snapshot root <code>{data.source.path}</code> ({data.source.userName}@{data.source.host}). Paths below are
          relative to it.
        </div>
        <div className="d-flex flex-wrap align-items-start gap-5">
          <div>
            <div className="small text-muted">Before</div>
            <b>{rfc3339TimestampForDisplay(data.from.startTime)}</b>
            <div className="small text-muted">
              {sizeDisplayName(data.from.summary?.size ?? 0, bytesStringBase2)} logical
            </div>
          </div>
          <div>
            <div className="small text-muted">After</div>
            <b>{rfc3339TimestampForDisplay(data.to.startTime)}</b>
            <div className="small text-muted">
              {sizeDisplayName(data.to.summary?.size ?? 0, bytesStringBase2)} logical
            </div>
          </div>
          <div className="d-flex flex-wrap gap-4 ms-lg-auto" data-testid="diff-summary">
            {total === 0 ? (
              <span>No differences.</span>
            ) : (
              <>
                {stat("success", "added", data.added, sizeDisplayName(data.addedBytes, bytesStringBase2))}
                {stat("danger", "removed", data.removed, sizeDisplayName(data.removedBytes, bytesStringBase2))}
                {stat("warning", "modified", data.modified, signed(data.modifiedDeltaBytes, bytesStringBase2) + " net")}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="d-flex flex-wrap align-items-stretch gap-3 mb-2">
        <div className="d-flex align-items-center gap-2 border rounded px-3 py-2 flex-grow-1">
          <span className="small text-muted">Show</span>
          {changeKinds.map((k) => (
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
          <Form.Control
            size="sm"
            placeholder="Filter by path"
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="diff-filter"
          />
        </div>

        <div className="d-flex align-items-center gap-3 border rounded px-3 py-2" data-testid="selection-bar">
          <span className={chosen.length === 0 ? "small text-muted" : "small"}>
            {chosen.length === 0
              ? "Nothing selected"
              : `${chosen.length} selected (${sizeDisplayName(chosenBytes, bytesStringBase2)})`}
          </span>
          {chosen.length > 0 && unticked.length > 0 && (
            <a
              href="#top"
              className="small"
              onClick={(e) => {
                e.preventDefault();
                selectPaths(matching, true);
              }}
            >
              Select all {compactCount(matching.length)} listed
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
        </div>
      </div>

      {data.truncated && (
        <div className="small text-muted mb-2" data-testid="diff-truncated">
          Only the first {compactCount(data.entries.length)} differences are listed; the totals above count all of them.
        </div>
      )}
      {result && (
        <div
          className={"mb-2 " + (result.ok ? "text-success" : "text-danger")}
          role="status"
          data-testid="exclude-result"
        >
          {result.ok
            ? `Excluded ${result.count} ${result.count === 1 ? "path" : "paths"}. The next snapshot skips ${result.count === 1 ? "it" : "them"}; copies in earlier snapshots stay until retention removes them.`
            : "Not changed: " + result.message}
        </div>
      )}

      <KopiaTable data={rows} columns={columns} />

      <Modal show={confirming} onHide={() => setConfirming(false)} data-testid="exclude-dialog">
        <Modal.Header closeButton>
          <Modal.Title>Exclude from backup</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="mb-2">
            Stop backing up {chosen.length === 1 ? "this path" : `these ${chosen.length} paths`} (
            {sizeDisplayName(chosenBytes, bytesStringBase2)})?
          </div>
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
                <code>{p}</code>
              </li>
            ))}
          </ul>
          {patterns.some((p) => !p.startsWith("/")) && (
            <div className="small mb-2">
              A pattern without a leading slash matches at any depth, so it also covers folders with that name that are
              not in the list, and any created later.
            </div>
          )}
          <div className="small">
            These patterns are added to the ignore rules of the policy for <code>{data.source.path}</code>. The next
            snapshot skips them. Copies already in earlier snapshots stay until those snapshots are removed by
            retention.
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={exclude} disabled={busy} data-testid="exclude-confirm">
            Exclude
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
