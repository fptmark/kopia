import axios from "axios";
import { sourceQueryStringParams } from "./policyutil";

export const KIND_LABELS = {
  permission: "permission denied",
  missing: "file vanished",
  busy: "file busy",
  other: "other errors",
};

export const EXPIRY_CHOICES = [
  { days: 0, label: "Forever" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** Hides errors from failure counts and notifications; rule is {source, path, scope: file|folder, kind?, expiresDays?}. */
export function addIgnoredError(rule) {
  return axios.post("/api/v1/ignored-errors", rule).then((r) => r.data);
}

export function listIgnoredErrors() {
  return axios.get("/api/v1/ignored-errors").then((r) => r.data.rules || []);
}

export function removeIgnoredError(id) {
  return axios.delete("/api/v1/ignored-errors/" + encodeURIComponent(id));
}

/** The pattern that excludes a path (relative to its source) from backups: anchored, with glob characters escaped. */
export function excludePattern(path) {
  return "/" + path.replace(/^\/+/, "").replace(/([\\*?[\]])/g, "\\$1");
}

/** Changes the ignore patterns of one policy; change maps the list of patterns to the new one. */
function editIgnorePatterns(target, change) {
  const url = "/api/v1/policy?" + sourceQueryStringParams(target);

  return axios
    .get(url)
    .catch(() => ({ data: {} })) // the source has no policy of its own yet; saving creates it
    .then((r) => {
      const policy = r.data || {};
      const files = { ...policy.files };
      const ignore = change(files.ignore || []);
      if (ignore.length > 0) {
        files.ignore = ignore;
      } else {
        delete files.ignore;
      }
      policy.files = files;
      return axios.put(url, policy);
    });
}

/** Adds a pattern to the ignore rules of the policy of target ({userName, host, path}). */
export function addIgnorePattern(target, pattern) {
  return editIgnorePatterns(target, (ignore) => (ignore.includes(pattern) ? ignore : [...ignore, pattern]));
}

/** Removes a pattern from the ignore rules of the policy of target. */
export function removeIgnorePattern(target, pattern) {
  return editIgnorePatterns(target, (ignore) => ignore.filter((p) => p !== pattern));
}

/**
 * Adds an exclusion for path (relative to the source) to the source's own policy, and returns the pattern.
 * source is {userName, host, path}.
 */
export function excludeFromBackup(source, path) {
  const pattern = excludePattern(path);

  return addIgnorePattern(source, pattern).then(() => pattern);
}

/** The last part of a path. */
export function baseName(path) {
  return path.replace(/\/+$/, "").split("/").pop();
}

/** The pattern that excludes every folder with this name, at any depth: unanchored, with a trailing slash. */
export function excludeFolderNamePattern(name) {
  return name.replace(/([\\*?[\]])/g, "\\$1") + "/";
}

/**
 * Adds exclusion patterns to the source's own policy in one save, so the changes cannot overwrite each other.
 * Returns the patterns.
 */
export function excludePatternsFromBackup(source, patterns) {
  return editIgnorePatterns(source, (ignore) => [...ignore, ...patterns.filter((p) => !ignore.includes(p))]).then(
    () => patterns,
  );
}

/** Adds an exclusion for each path (relative to the source) to the source's own policy in one save. */
export function excludeManyFromBackup(source, paths) {
  return excludePatternsFromBackup(source, paths.map(excludePattern));
}
