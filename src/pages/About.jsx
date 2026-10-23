/* global __UI_VERSION__ */
import { useState } from "react";
import Table from "react-bootstrap/Table";

// Features added on top of upstream Kopia in this build.
const CUSTOM_FEATURES = [
  "Snapshot error icon opens a dialog listing the failed paths",
  "Repository page shows total size on storage",
  "Preferences > Scheduling: keep Mac awake during snapshots",
  "About page (version moved here from the page footer)",
  "Files tab: List/Restore finds files and folders across snapshots, grouped by version with first/last snapshot dates; Excluded lists every policy ignore pattern",
  "Notifications: iMessage, email and Mac alerts for failures, with immediate or periodic success summaries; ignore rules hide errors that are not worth reporting",
  "Backup health: daily restore check and alerts when backups go stale",
  "Snapshot frequency as a number and a unit (sec, min, hr, days) on the Snapshots page and in policies",
];

/**
 * Shows the server version (injected into the page by the server) and the UI bundle that is loaded.
 */
export function About() {
  // the server fills in the build version in this element, which is kept hidden in the footer.
  const [serverVersion] = useState(
    () =>
      document
        .querySelector("#appVersion .version-info")
        ?.textContent?.replace(/^Version\s+/, "")
        .replace("%VITE_FULL_VERSION_INFO%", "")
        .trim() || "unknown",
  );

  const [bundle] = useState(
    () =>
      Array.from(document.querySelectorAll("script[src]"))
        .map((s) => s.getAttribute("src"))
        .find((src) => src.includes("index-")) || "unknown",
  );

  return (
    <>
      <h5 className="mb-3">About</h5>
      <Table size="sm" data-testid="about-table">
        <tbody>
          <tr>
            <th>Server version</th>
            <td data-testid="about-version">{serverVersion}</td>
          </tr>
          <tr>
            <th>UI version</th>
            <td data-testid="about-ui-version">{__UI_VERSION__}</td>
          </tr>
          <tr>
            <th>UI bundle</th>
            <td>{bundle}</td>
          </tr>
          <tr>
            <th>Page loaded from</th>
            <td>{window.location.origin}</td>
          </tr>
          <tr>
            <th>Custom features</th>
            <td>
              <ul className="mb-0">
                {CUSTOM_FEATURES.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </td>
          </tr>
        </tbody>
      </Table>
    </>
  );
}
