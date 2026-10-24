import React from "react";
import Breadcrumb from "react-bootstrap/Breadcrumb";
import { useLocation, useNavigate } from "react-router";

/**
 * The trail of folders that led to this page. Each page in the trail passes {label, oid, prevState} as the
 * router state; going back to a crumb goes back that many pages.
 */
export function Breadcrumbs() {
  const location = useLocation();
  const navigate = useNavigate();

  const trail = [];
  for (let s = location.state; s; s = s.prevState) {
    trail.unshift(s);
  }

  if (trail.length === 0) {
    return null;
  }

  return (
    <Breadcrumb listProps={{ className: "mb-2" }} aria-label="Folders">
      {trail.map((s, i) => {
        const back = trail.length - i - 1;
        return (
          <Breadcrumb.Item
            key={back}
            active={back === 0}
            linkProps={{ role: "button" }}
            onClick={() => {
              if (back) {
                navigate(-back);
              }
            }}
          >
            {s.label}
          </Breadcrumb.Item>
        );
      })}
    </Breadcrumb>
  );
}
