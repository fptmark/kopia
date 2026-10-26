import { api } from "./api";
import { formatDateTime } from "./format";
import { historyUrl } from "./snapshots";
import { objectLink } from "../utils/formatutils";

export const loadDirectory = (oid) => api.get("/api/v1/objects/" + oid).then((r) => r.data);
export const loadMount = (oid) =>
  api.get("/api/v1/mounts/" + oid).then(
    (r) => r.data,
    () => ({}),
  );
export const mountDirectory = (oid) => api.post("/api/v1/mounts", { root: oid }).then((r) => r.data);
export const unmountDirectory = (oid) => api.delete("/api/v1/mounts/" + oid);
export const loadSnapshotTask = (snapshotId) =>
  api.get("/api/v1/snapshots/task", { params: { snapshotId } }).then((r) => r.data.taskId);

/** The link that opens a snapshot in the browser, with the state its breadcrumbs and facts are drawn from. */
export const snapshotBrowse = (source, snapshot, previousId) => ({
  to: objectLink(snapshot.rootID),
  state: { label: formatDateTime(snapshot.startTime), snapshot: { ...snapshot, source, previousId } },
});

export const startRestore = (req) => api.post("/api/v1/restore", req).then((r) => r.data);

const SNAPSHOTS = { label: "Sources", to: "/snapshots" };

/**
 * The breadcrumbs for a page inside a snapshot: Sources, the source (its history), then each folder opened on the
 * way (the router state of each page carries {label, oid, prevState, snapshot}). The folder being shown is the
 * last one; it is a link too unless current is set.
 */
export function browseTrail(state, oid, { current = false } = {}) {
  const trail = [SNAPSHOTS];
  if (state?.snapshot?.source) {
    trail.push({ label: state.snapshot.source.path, to: historyUrl(state.snapshot.source) });
  }

  const chain = [];
  for (let s = state; s; s = s.prevState) {
    chain.unshift(s);
  }

  chain.forEach((s, i) => {
    const last = i === chain.length - 1;
    const at = last ? oid : (s.oid ?? s.snapshot?.rootID);
    const crumb = { label: s.label };
    if (at && !(last && current)) {
      crumb.to = "/snapshots/dir/" + at;
      crumb.state = { ...s, items: undefined };
    }
    trail.push(crumb);
  });

  return trail;
}

/** The size shown for a directory entry: a file's own, or a folder's total. */
export function entrySize(item) {
  return item.size || item.summ?.size || 0;
}

/** Link target of an entry: a folder opens in the browser, a file downloads. */
export function entryLink(item) {
  return item.obj.startsWith("k")
    ? { page: true, to: "/snapshots/dir/" + item.obj }
    : { page: false, href: "/api/v1/objects/" + item.obj + "?fname=" + encodeURIComponent(item.name) };
}

/** The request that restores a snapshot folder; the destination's ending decides between files, zip and tar. */
export function restoreRequest(oid, form) {
  const dst = form.destination.trim();
  const req = {
    root: oid,
    options: {
      incremental: form.incremental,
      ignoreErrors: form.continueOnErrors,
      restoreDirEntryAtDepth: Number(form.restoreDirEntryAtDepth),
      minSizeForPlaceholder: Number(form.minSizeForPlaceholder),
    },
  };

  if (dst.endsWith(".zip")) {
    req.zipFile = dst;
    req.uncompressedZip = form.uncompressedZip;
  } else if (dst.endsWith(".tar")) {
    req.tarFile = dst;
  } else {
    req.fsOutput = {
      targetPath: dst,
      skipOwners: !form.restoreOwnership,
      skipPermissions: !form.restorePermissions,
      skipTimes: !form.restoreModTimes,
      ignorePermissionErrors: form.ignorePermissionErrors,
      overwriteFiles: form.overwriteFiles,
      overwriteDirectories: form.overwriteDirectories,
      overwriteSymlinks: form.overwriteSymlinks,
      writeFilesAtomically: form.writeFilesAtomically,
      writeSparseFiles: form.writeSparseFiles,
    };
  }

  return req;
}

export const RESTORE_DEFAULTS = {
  destination: "",
  incremental: true,
  continueOnErrors: false,
  restoreOwnership: true,
  restorePermissions: true,
  restoreModTimes: true,
  uncompressedZip: true,
  overwriteFiles: false,
  overwriteDirectories: false,
  overwriteSymlinks: false,
  ignorePermissionErrors: true,
  writeFilesAtomically: false,
  writeSparseFiles: false,
  restoreDirEntryAtDepth: 1000,
  minSizeForPlaceholder: 0,
};
