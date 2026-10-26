import React from "react";
import { Navigate, useParams } from "react-router";
import { snapshotBrowse } from "../browse";
import { useLoad } from "../hooks";
import { loadHistory } from "../snapshots";
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
    const source = { host: t.host, userName: t.userName, path: t.source };
    const list = [...((await loadHistory(source, true)).snapshots ?? [])].sort(
      (a, b) => new Date(b.startTime) - new Date(a.startTime),
    );
    const i = list.findIndex((s) => s.id === t.snapshotId);
    return i < 0 ? null : snapshotBrowse(source, list[i], list[i + 1]?.id);
  }, [tid]);

  if (found.loading) {
    return null;
  }

  return found.data ? <Navigate replace {...found.data} /> : <Navigate replace to={"/tasks/" + tid} />;
}
