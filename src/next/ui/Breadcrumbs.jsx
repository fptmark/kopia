import React from "react";
import Breadcrumb from "react-bootstrap/Breadcrumb";
import { Link } from "react-router";

/**
 * Where this page sits: every page's way back. trail is [{label, to?, state?}] from the top down; an item with
 * `to` is a link, one without is the current place. Pages pass it to <Page trail>.
 */
export function Breadcrumbs({ trail }) {
  if (!trail?.length) {
    return null;
  }

  return (
    <Breadcrumb className="nx-crumbs" listProps={{ className: "mb-0" }} aria-label="Where you are">
      {trail.map((c) => (
        <Breadcrumb.Item
          key={c.label + (c.to ?? "")}
          active={!c.to}
          linkAs={Link}
          linkProps={c.to ? { to: c.to, state: c.state } : undefined}
        >
          {c.label}
        </Breadcrumb.Item>
      ))}
    </Breadcrumb>
  );
}
