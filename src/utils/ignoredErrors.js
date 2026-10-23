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

/**
 * Adds an exclusion for path (relative to the source) to the source's own policy, and returns the pattern.
 * source is {userName, host, path}.
 */
export function excludeFromBackup(source, path) {
  const url = "/api/v1/policy?" + sourceQueryStringParams(source);
  const pattern = excludePattern(path);

  return axios
    .get(url)
    .catch(() => ({ data: {} })) // the source has no policy of its own yet; saving creates it
    .then((r) => {
      const policy = r.data || {};
      const files = { ...policy.files };
      const ignore = files.ignore || [];
      if (!ignore.includes(pattern)) {
        files.ignore = [...ignore, pattern];
      }
      policy.files = files;
      return axios.put(url, policy);
    })
    .then(() => pattern);
}
