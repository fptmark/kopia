import React from "react";
import Nav from "react-bootstrap/Nav";

/** Tabs within a page. tabs is [{id, label, badge?, strong?}]; strong bolds the label (e.g. "has settings"). */
export function TabNav({ tabs, active, onChange, ...rest }) {
  return (
    <Nav className="nx-subtabs" activeKey={active} onSelect={(k) => onChange(k)} {...rest}>
      {tabs.map((t) => (
        <Nav.Item key={t.id}>
          <Nav.Link
            eventKey={t.id}
            data-testid={"tab-" + t.id}
            data-label={t.label}
            className={t.strong ? "fw-semibold" : undefined}
          >
            {t.label}
            {t.badge !== undefined && t.badge !== null && t.badge !== "" && (
              <span className="nx-badge neutral">{t.badge}</span>
            )}
          </Nav.Link>
        </Nav.Item>
      ))}
    </Nav>
  );
}
