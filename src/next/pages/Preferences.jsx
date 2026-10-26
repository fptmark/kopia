import React from "react";
import { useLocation, useNavigate } from "react-router";
import { queryState } from "../hooks";
import { IgnoredErrors } from "../preferences/IgnoredErrors";
import { Notifications } from "../preferences/Notifications";
import { Settings } from "../preferences/Settings";
import { Page, Panel, TabNav } from "../ui";

const TABS = [
  { id: "settings", label: "Settings", view: Settings },
  { id: "notifications", label: "Notifications", view: Notifications },
  { id: "ignored", label: "Ignored errors", view: IgnoredErrors },
];

export function Preferences() {
  const location = useLocation();
  const navigate = useNavigate();
  const [q, set] = queryState(location, navigate);
  const active = TABS.find((t) => t.id === q.tab) ?? TABS[0];
  const View = active.view;

  return (
    <Page title="Preferences">
      <TabNav tabs={TABS} active={active.id} onChange={(id) => set({ tab: id })} />
      <Panel>
        <View />
      </Panel>
    </Page>
  );
}
