import { api } from "./api";

export const loadDirectory = (oid) => api.get("/api/v1/objects/" + oid).then((r) => r.data);
export const loadMount = (oid) =>
  api.get("/api/v1/mounts/" + oid).then(
    (r) => r.data,
    () => ({}),
  );
export const mountDirectory = (oid) => api.post("/api/v1/mounts", { root: oid }).then((r) => r.data);
export const unmountDirectory = (oid) => api.delete("/api/v1/mounts/" + oid);
export const startRestore = (req) => api.post("/api/v1/restore", req).then((r) => r.data);

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
