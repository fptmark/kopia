import React from "react";
import { Link, useNavigate } from "react-router";

/**
 * The frame every page uses: optional back link, title with a line under it, and actions on the right.
 * back is a path to link to, or true for "the page before".
 */
export function Page({ title, subtitle, back, backLabel = "Back", actions, children }) {
  const navigate = useNavigate();

  return (
    <div className="nx-page" data-testid="page">
      {back && typeof back === "string" && (
        <Link className="nx-back" to={back}>
          {"←"} {backLabel}
        </Link>
      )}
      {back === true && (
        <a
          className="nx-back"
          href="#back"
          onClick={(e) => {
            e.preventDefault();
            navigate(-1);
          }}
        >
          {"←"} {backLabel}
        </a>
      )}
      {(title || actions) && (
        <div className="nx-page-header">
          <div>
            {title && <h1 className="nx-page-title">{title}</h1>}
            {subtitle && <div className="nx-page-subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="nx-page-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
