import "bootstrap/dist/css/bootstrap.min.css";
import "./next.css";
import React, { use, useCallback, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router";
import { api, setupApi } from "./api";
import { NextContext } from "./context";
import { UIPreferenceProvider, UIPreferencesContext } from "../contexts/UIPreferencesContext";
import { Spec } from "./pages/Spec";
import { Exclusions } from "./pages/Exclusions";
import { Snapshots } from "./pages/Snapshots";
import { SnapshotHistory } from "./pages/SnapshotHistory";
import { SnapshotDiff } from "./pages/SnapshotDiff";

setupApi();

const TABS = [
  { to: "/snapshots", label: "Snapshots", needsRepo: true },
  { to: "/files", label: "Files", needsRepo: true },
  { to: "/exclusions", label: "Exclusions", needsRepo: true },
  { to: "/policies", label: "Policies", needsRepo: true },
  { to: "/tasks", label: "Tasks", needsRepo: true },
  { to: "/repo", label: "Repository" },
  { to: "/preferences", label: "Preferences" },
  { to: "/about", label: "About" },
];

// The saved theme names are the old UI's four; the new UI has light and dark.
function bsTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

function Shell({ children }) {
  const { theme } = use(UIPreferencesContext);
  const [repo, setRepo] = useState({ connected: false, description: "" });
  const [running, setRunning] = useState(0);

  const refreshRepo = useCallback(() => {
    api
      .get("/api/v1/repo/status")
      .then((r) => setRepo({ connected: !!r.data.connected, description: r.data.description || "" }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshRepo();
    const repoTimer = window.setInterval(refreshRepo, 5000);
    const taskTimer = window.setInterval(() => {
      api
        .get("/api/v1/tasks-summary")
        .then((r) => setRunning(r.data["RUNNING"] || 0))
        .catch(() => {});
    }, 5000);
    return () => {
      window.clearInterval(repoTimer);
      window.clearInterval(taskTimer);
    };
  }, [refreshRepo]);

  const ctx = useMemo(
    () => ({
      repoConnected: repo.connected,
      repoDescription: repo.description,
      runningTasks: running,
      refreshRepo,
    }),
    [repo, running, refreshRepo],
  );

  return (
    <NextContext value={ctx}>
      <div className="nx" data-bs-theme={bsTheme(theme)}>
        <nav className="nx-nav" aria-label="Main">
          <div className="nx-nav-inner">
            <a className="nx-brand" href="/next/snapshots">
              <img src="/kopia-flat.svg" alt="Kopia" />
            </a>
            <div>
              {TABS.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  data-testid={"tab" + t.to.replace("/", "-")}
                  className={({ isActive }) =>
                    "nx-tab" + (isActive ? " active" : "") + (t.needsRepo && !repo.connected ? " disabled" : "")
                  }
                >
                  {t.label}
                  {t.to === "/tasks" && running > 0 && ` (${running})`}
                </NavLink>
              ))}
            </div>
            <span className="nx-repo">{repo.description}</span>
          </div>
        </nav>
        <main className="nx-shell">{children}</main>
      </div>
    </NextContext>
  );
}

export default function NextApp() {
  return (
    <BrowserRouter basename="/next">
      <UIPreferenceProvider>
        <Shell>
          <Routes>
            <Route path="spec" element={<Spec />} />
            <Route path="snapshots" element={<Snapshots />} />
            <Route path="snapshots/single-source" element={<SnapshotHistory />} />
            <Route path="snapshots/diff" element={<SnapshotDiff />} />
            <Route path="exclusions" element={<Exclusions />} />
            <Route path="/" element={<Navigate to="/snapshots" replace />} />
            <Route path="*" element={<div className="nx-empty">Not built yet.</div>} />
          </Routes>
        </Shell>
      </UIPreferenceProvider>
    </BrowserRouter>
  );
}
