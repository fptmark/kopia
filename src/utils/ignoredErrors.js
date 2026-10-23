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
