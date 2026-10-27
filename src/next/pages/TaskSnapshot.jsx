import React from "react";
import { Navigate, useParams } from "react-router";
import { loadSnapshotBrowse } from "../browse";
import { useLoad } from "../hooks";
import { loadTaskErrors } from "../tasks";

/**
 * Opens the snapshot a snapshot task made in the snapshot browser, the same page as from History. A task that
 * made no snapshot (failed, running, or from before snapshot IDs were recorded) shows the task instead.
 */
export function TaskSnapshot() {
  const { tid } = useParams();
  const found = useLoad(async () => {
    const t = await loadTaskErrors(tid);
    if (!t.snapshotId || !t.source) {
      return null;
    }
    return loadSnapshotBrowse({ host: t.host, userName: t.userName, path: t.source }, t.snapshotId);
  }, [tid]);

  if (found.loading) {
    return null;
  }

  return found.data ? <Navigate replace {...found.data} /> : <Navigate replace to={"/tasks/" + tid} />;
}
