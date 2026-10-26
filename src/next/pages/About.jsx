/* global __UI_VERSION__ */
import React, { useState } from "react";
import { DataTable, Page } from "../ui";

// Features added on top of upstream Kopia in this build.
const CUSTOM_FEATURES = [
  "Snapshot history: logical size, what each snapshot added to the repository, compare two snapshots",
  "Exclusions: global and per-source rules written into Kopia's policies, with a preview and add dates",
  "Failed files dialog: ignore an error or exclude the file from the backup",
  "Files: find files and folders across snapshots, grouped by version",
  "Permanent task history, with the failed files of each snapshot",
  "Backup health checks, with alerts for stale or incomplete backups",
  "Notifications: iMessage, email and Mac alerts, immediate or as summaries",
  "Keep the Mac awake during snapshots",
  "Snapshot frequency as a number and a unit",
];

/** The server version (the server puts it into the page), the UI that is loaded, and what this build adds. */
export function About() {
  const [serverVersion] = useState(
    () =>
      document
        .querySelector("#appVersion .version-info")
        ?.textContent?.replace(/^Version\s+/, "")
        .replace("%VITE_FULL_VERSION_INFO%", "")
        .replace(/^vv/, "v")
        .trim() || "unknown",
  );
  const [bundle] = useState(
    () =>
      Array.from(document.querySelectorAll("script[src]"))
        .map((s) => s.getAttribute("src"))
        .find((src) => src.includes("index-")) || "unknown",
  );

  const rows = [
    { k: "Server version", v: <span data-testid="about-version">{serverVersion}</span> },
    { k: "UI version", v: <span data-testid="about-ui-version">{__UI_VERSION__}</span> },
    { k: "UI bundle", v: bundle },
    { k: "Page loaded from", v: window.location.origin },
    {
      k: "Added in this build",
      v: (
        <ul className="mb-0 ps-3">
          {CUSTOM_FEATURES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ),
    },
  ];

  return (
    <Page title="About">
      <DataTable
        label="about"
        data={rows}
        getRowId={(r) => r.k}
        footer={false}
        head={false}
        data-testid="about-table"
        columns={[
          { id: "k", header: "", cell: (r) => <b>{r.k}</b>, width: "14rem" },
          { id: "v", header: "", cell: (r) => r.v },
        ]}
      />
    </Page>
  );
}
