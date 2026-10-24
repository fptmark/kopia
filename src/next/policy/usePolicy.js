import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api";
import { useDebounced } from "../hooks";
import { sourceQueryStringParams } from "../snapshots";
import { cleanPolicy, setPath } from "./helpers";

const url = (target) => "/api/v1/policy?" + sourceQueryStringParams(target);

/**
 * Loads the policy of a target ({host, userName, path}), keeps the edits, asks the server what is in effect
 * for them, and saves or deletes. Returns {policy, loaded, error, isNew, change, resolved, algorithms,
 * valid, save, remove, dirty}. valid() returns the policy to save or throws an Error saying what is wrong.
 */
export function usePolicy(target, { enabled = true } = {}) {
  const [policy, setPolicy] = useState(null);
  const [original, setOriginal] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState(null);
  const [algorithms, setAlgorithms] = useState(null);
  const key = sourceQueryStringParams(target);

  useEffect(() => {
    // a new target starts from nothing, so the old one's settings are never shown or saved for it
    setPolicy(null);
    setResolved(null);
    setError("");
    if (!enabled) {
      return undefined;
    }
    let live = true;
    api
      .get("/api/v1/repo/algorithms")
      .then((r) => live && setAlgorithms(r.data))
      .catch(() => {});
    api
      .get(url(target))
      .then((r) => {
        if (live) {
          setPolicy(r.data || {});
          setOriginal(JSON.stringify(cleanPolicy(r.data || {})));
          setIsNew(false);
        }
      })
      .catch((e) => {
        if (!live) {
          return;
        }
        if (e.response?.data?.code === "NOT_FOUND" || e.response?.status === 404) {
          setPolicy({});
          setOriginal("{}");
          setIsNew(true);
        } else {
          setError(errorMessage(e));
        }
      });
    return () => {
      live = false;
    };
    // the target is its query string
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [key, enabled]);

  const draft = useMemo(() => {
    try {
      return JSON.stringify(cleanPolicy(policy));
    } catch {
      return null; // a time of day that is still being typed
    }
  }, [policy]);
  const settled = useDebounced(draft, 300);

  useEffect(() => {
    if (settled === null || policy === null) {
      return undefined;
    }
    let live = true;
    api
      .post("/api/v1/policy/resolve?" + key, { updates: JSON.parse(settled), numUpcomingSnapshotTimes: 5 })
      .then((r) => live && setResolved(r.data))
      .catch(() => {});
    return () => {
      live = false;
    };
    // the policy itself is what settled is made from
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [settled, key]);

  const change = useCallback((path, value) => setPolicy((p) => setPath(p, path, value)), []);
  const valid = useCallback(() => cleanPolicy(policy), [policy]);
  const save = useCallback(() => api.put(url(target), cleanPolicy(policy)), [policy, target]);
  const remove = useCallback(() => api.delete(url(target)), [target]);

  return {
    policy,
    loaded: policy !== null,
    error,
    isNew,
    change,
    resolved,
    algorithms,
    valid,
    save,
    remove,
    // a setting that cannot be read yet (a time still being typed) counts as a change, so Save can say what is wrong
    dirty: draft === null || draft !== original,
  };
}
