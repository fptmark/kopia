import "bootstrap/dist/css/bootstrap.min.css";
import "./next.css";
import React, { use, useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, Outlet, RouterProvider, createBrowserRouter } from "react-router";
import { api, setupApi } from "./api";
import { NextContext } from "./context";
import { TaskStatus } from "./tasks";
import { HealthBanner } from "./ui";
import { UIPreferenceProvider, UIPreferencesContext } from "../contexts/UIPreferencesContext";
import { Spec } from "./pages/Spec";
import { Exclusions } from "./pages/Exclusions";
import { Snapshots } from "./pages/Snapshots";
import { SnapshotHistory } from "./pages/SnapshotHistory";
import { SnapshotDiff } from "./pages/SnapshotDiff";
import { About } from "./pages/About";
import { Files } from "./pages/Files";
import { Preferences } from "./pages/Preferences";
import { Repository } from "./pages/Repository";
import { Policies } from "./pages/Policies";
import { Policy } from "./pages/Policy";
import { SnapshotCreate } from "./pages/SnapshotCreate";
import { SnapshotDirectory } from "./pages/SnapshotDirectory";
import { SnapshotRestore } from "./pages/SnapshotRestore";
import { Tasks } from "./pages/Tasks";
import { Task } from "./pages/Task";
import { TaskSnapshot } from "./pages/TaskSnapshot";

setupApi();

const TABS = [
  { to: "/snapshots", label: "Sources", needsRepo: true },
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

function Shell() {
  const { theme } = use(UIPreferencesContext);
  const [repo, setRepo] = useState({ connected: false, description: "" });
  const [running, setRunning] = useState(0);

  // Bootstrap's own [data-bs-theme] rules are what color a Modal, but a Modal portals to document.body,
  // outside the .nx div -- so the theme has to live on <html> too, or every dialog renders light.
  useEffect(() => {
    document.documentElement.setAttribute("data-bs-theme", bsTheme(theme));
    return () => document.documentElement.removeAttribute("data-bs-theme");
  }, [theme]);

  const refreshRepo = useCallback(() => {
    api
      .get("/api/v1/repo/status")
      .then((r) => setRepo({ connected: !!r.data.connected, description: r.data.description || "" }))
      .catch(() => {});
  }, []);

  const refreshTasks = useCallback(() => {
    api
      .get("/api/v1/tasks-summary")
      .then((r) => setRunning(r.data[TaskStatus.RUNNING] || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshRepo();
    refreshTasks();
    const repoTimer = window.setInterval(refreshRepo, 5000);
    const taskTimer = window.setInterval(refreshTasks, 5000);
    return () => {
      window.clearInterval(repoTimer);
      window.clearInterval(taskTimer);
    };
  }, [refreshRepo, refreshTasks]);

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
            <Link className="nx-brand" to="/snapshots">
              <img src="/kopia-flat.svg" alt="Kopia" />
            </Link>
            <div>
              {TABS.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  data-testid={"tab" + t.to.replace("/", "-")}
                  data-label={t.label}
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
        <main className="nx-shell">
          <HealthBanner />
          <Outlet />
        </main>
      </div>
    </NextContext>
  );
}

// A data router (rather than plain BrowserRouter) so Page can use useBlocker to guard navigation away
// from unsaved changes.
const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "spec", element: <Spec /> },
      { path: "snapshots", element: <Snapshots /> },
      { path: "snapshots/single-source", element: <SnapshotHistory /> },
      { path: "snapshots/diff", element: <SnapshotDiff /> },
      { path: "exclusions", element: <Exclusions /> },
      { path: "files", element: <Files /> },
      { path: "preferences", element: <Preferences /> },
      { path: "about", element: <About /> },
      { path: "repo", element: <Repository /> },
      { path: "policies", element: <Policies /> },
      { path: "policies/edit", element: <Policy /> },
      { path: "snapshots/new", element: <SnapshotCreate /> },
      { path: "snapshots/dir/:oid", element: <SnapshotDirectory /> },
      { path: "snapshots/dir/:oid/restore", element: <SnapshotRestore /> },
      { path: "tasks", element: <Tasks /> },
      { path: "tasks/:tid", element: <Task /> },
      { path: "snapshots/of-task/:tid", element: <TaskSnapshot /> },
      { path: "/", element: <Navigate to="/snapshots" replace /> },
      { path: "*", element: <div className="nx-empty">Not built yet.</div> },
    ],
  },
]);

export default function NextApp() {
  return (
    <UIPreferenceProvider>
      <RouterProvider router={router} />
    </UIPreferenceProvider>
  );
}
