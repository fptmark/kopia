import axios from "axios";

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
