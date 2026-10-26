import React from "react";
import Nav from "react-bootstrap/Nav";

/** Tabs within a page. tabs is [{id, label, badge?}]; the page decides what to show for the active id. */
export function TabNav({ tabs, active, onChange, ...rest }) {
  return (
    <Nav className="nx-subtabs" activeKey={active} onSelect={(k) => onChange(k)} {...rest}>
      {tabs.map((t) => (
        <Nav.Item key={t.id}>
          <Nav.Link eventKey={t.id} data-testid={"tab-" + t.id} data-label={t.label}>
            {t.label}
            {t.badge !== undefined && t.badge !== null && t.badge !== "" && (
              <span className="nx-badge neutral ms-2">{t.badge}</span>
            )}
          </Nav.Link>
        </Nav.Item>
      ))}
    </Nav>
  );
}
