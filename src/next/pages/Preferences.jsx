import React from "react";
import { useLocation, useNavigate } from "react-router";
import { queryState } from "../hooks";
import { Appearance } from "../preferences/Appearance";
import { Health } from "../preferences/Health";
import { IgnoredErrors } from "../preferences/IgnoredErrors";
import { Notifications } from "../preferences/Notifications";
import { Scheduling } from "../preferences/Scheduling";
import { Page, Panel, TabNav } from "../ui";

const TABS = [
  { id: "appearance", label: "Appearance", view: Appearance },
  { id: "scheduling", label: "Scheduling", view: Scheduling },
  { id: "health", label: "Backup health", view: Health },
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
