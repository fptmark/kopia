import React from "react";
import { Breadcrumbs } from "./Breadcrumbs";

/**
 * The frame every page uses: breadcrumbs, optional title with a line under it, and actions on the right.
 * trail is [{label, to?, state?}] from the top down; see Breadcrumbs.
 */
export function Page({ title, subtitle, trail, actions, children }) {
  return (
    <div className="nx-page" data-testid="page">
      <Breadcrumbs trail={trail} />
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
