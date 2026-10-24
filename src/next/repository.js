import { api } from "./api";

export const loadRepoStatus = () => api.get("/api/v1/repo/status").then((r) => r.data);
export const disconnectRepo = () => api.post("/api/v1/repo/disconnect", {});
export const setRepoDescription = (description) =>
  api.post("/api/v1/repo/description", { description }).then((r) => r.data);

/** The size of the repository on storage: the last result and whether a calculation is running; refresh starts one. */
export const loadStorageUsage = (refresh) =>
  api.get("/api/v1/repo/storage-usage", { params: { refresh: refresh ? "true" : "false" } }).then((r) => r.data);

/** "2:05" for 125 seconds. */
export function clock(seconds) {
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

/** The rows of facts shown for a connected repository; a server repository has no storage details. */
export function repoFacts(status) {
  if (status.apiServerURL) {
    return [["Server URL", status.apiServerURL]];
  }
  return [
    ["Config file", status.configFile],
    ["Storage provider", status.storage],
    ["Encryption", status.encryption],
    ["Hash", status.hash],
    ["Splitter", status.splitter],
    ["Repository format", status.formatVersion],
    [
      "Error correction",
      status.eccOverheadPercent > 0 ? `${status.ecc || ""} ${status.eccOverheadPercent}%`.trim() : "Disabled",
    ],
    ["Internal compression", status.supportsContentCompression ? "yes" : "no"],
  ];
}
