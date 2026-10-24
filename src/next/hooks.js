import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

/**
 * Loads data and keeps it: { data, error, loading, reload }.
 *
 * load is a function returning a promise of the data (or a URL, which is fetched as JSON). It runs again when
 * deps change and, if refreshMs is set, on that interval without showing the loading state. A newer request
 * wins; an older answer that arrives late is dropped.
 */
export function useLoad(load, deps = [], { refreshMs = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: enabled });
  const latestRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback((quiet) => {
    const id = ++latestRef.current;
    if (!quiet) {
      setState((s) => ({ ...s, loading: true, error: null }));
    }
    const source = loadRef.current;
    const promise = typeof source === "string" ? api.get(source).then((r) => r.data) : source();
    promise.then(
      (data) => id === latestRef.current && setState({ data, error: null, loading: false }),
      (e) => id === latestRef.current && setState((s) => ({ data: s.data, error: errorMessage(e), loading: false })),
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    run(false);
    if (!refreshMs) {
      return undefined;
    }
    const t = window.setInterval(() => run(true), refreshMs);
    return () => window.clearInterval(t);
    // deps is the caller's list of what the request depends on
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [enabled, refreshMs, run, ...deps]);

  const reload = useCallback(() => run(false), [run]);
  const refresh = useCallback(() => run(true), [run]);

  return { ...state, reload, refresh };
}

/** A value that follows another one after it has stopped changing for ms. */
export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The query string of the page as an object, and a function that changes it without adding history entries. */
export function queryState(location, navigate) {
  const q = Object.fromEntries(new URLSearchParams(location.search));
  const set = (changes) => {
    const next = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined || v === null || v === "") {
        next.delete(k);
      } else {
        next.set(k, v);
      }
    }
    navigate({ search: next.toString() }, { replace: true });
  };
  return [q, set];
}
