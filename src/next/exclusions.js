// The exclusion rules API, and what a pattern means in words.
import { api } from "./api";

/**
 * What a pattern matches, from Kopia's gitignore-style rules:
 * - no slash (apart from a trailing one): any folder or file with that name, at any depth
 * - a leading slash, or a slash inside: from the root of the snapshot source
 * - a trailing slash: folders only
 */
export function describePattern(pattern) {
  const p = String(pattern).trim();
  const foldersOnly = p.endsWith("/");
  const body = foldersOnly ? p.slice(0, -1) : p;
  const anchored = body.startsWith("/") || body.includes("/");
  const wildcard = /[*?[]/.test(body);

  return {
    anchored,
    foldersOnly,
    wildcard,
    scope: anchored ? "From the source root" : "Any depth",
    what: foldersOnly ? "folders" : "files and folders",
  };
}

/** A pattern is "path style" when it only means something in sources that have that path. */
export function isPathStyle(pattern) {
  return describePattern(pattern).anchored;
}

export function loadExclusions() {
  return api.get("/api/v1/exclusions").then((r) => r.data);
}

/** rules: [{source, pattern, note?}]; addedBy: manual, compare or failed. */
export function addExclusions(rules, addedBy = "manual") {
  return api.post("/api/v1/exclusions", { rules, addedBy }).then((r) => r.data);
}

export function removeExclusion(id) {
  return api.delete("/api/v1/exclusions/" + encodeURIComponent(id)).then((r) => r.data);
}

export function loadNetRules(source) {
  return api.get("/api/v1/exclusions/net", { params: { source } }).then((r) => r.data);
}

/** Writes the rules into Kopia's policies; sources limits it, none means everything. */
export function reconcileExclusions(sources) {
  return api.post("/api/v1/exclusions/reconcile", sources ? { sources } : {}).then((r) => r.data);
}

/** What patterns would leave out of the newest snapshot of a source. */
export function previewExclusions(source, patterns) {
  return api.post("/api/v1/exclusions/preview", { source, patterns }).then((r) => r.data);
}
