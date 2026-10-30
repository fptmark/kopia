import React from "react";
import { useLocation, useNavigate } from "react-router";
import { queryState } from "../hooks";
import { IgnoredErrors } from "../preferences/IgnoredErrors";
import { Notifications } from "../preferences/Notifications";
import { Settings } from "../preferences/Settings";
import { useSettingsDraft } from "../preferences/useSettingsDraft";
import { Page, TabNav } from "../ui";

const TABS = [
  { id: "settings", label: "Settings" },
  { id: "notifications", label: "Notifications" },
  { id: "ignored", label: "Ignored errors" },
];

export function Preferences() {
  const location = useLocation();
  const navigate = useNavigate();
  const [q, set] = queryState(location, navigate);
  const active = TABS.find((t) => t.id === q.tab) ?? TABS[0];
  const settings = useSettingsDraft();

  return (
    // dirty/onSave/onDiscard stay wired to Settings regardless of the active tab: switching to
    // Notifications or Ignored errors must not hide an unsaved Settings change or stop warning before
    // navigating away from it.
    <Page title="Preferences" dirty={settings.dirty} onSave={settings.save} onDiscard={settings.discard}>
      <TabNav tabs={TABS} active={active.id} onChange={(id) => set({ tab: id })} />
      {active.id === "settings" && <Settings draft={settings.draft} change={settings.change} />}
      {active.id === "notifications" && <Notifications />}
      {active.id === "ignored" && <IgnoredErrors />}
    </Page>
  );
}
