import React, { useMemo, useState } from "react";
import { useLocation } from "react-router";
import { Breadcrumbs } from "./Breadcrumbs";
import { PagerSlotContext } from "./PagerSlot";
import { TrailContext } from "./TrailContext";

/**
 * The frame every page uses: breadcrumbs, optional title with a line under it, and actions on the right.
 *
 * trail is the page's own place: [{label, to?, state?}] from the top down, an item without `to` being the page
 * itself. Pages opened from another page with a FromLink show that page's trail instead,
 * then themselves; crumb names the page in that trail when the title is not what it should be called.
 */
export function Page({ title, subtitle, trail, crumb, actions, children }) {
  const [slot, setSlot] = useState(null);
  const pager = useMemo(() => ({ slot, setSlot }), [slot]);
  const location = useLocation();

  const own = trail ?? [];
  const last = own[own.length - 1];
  const name = (last && !last.to ? last.label : undefined) ?? crumb ?? (typeof title === "string" ? title : undefined);
  const from = Array.isArray(location.state?.from) ? location.state.from : undefined;
  const shown = from && name ? [...from, { label: name }] : own;
  const here = useMemo(
    () => [
      ...shown.filter((c) => c.to),
      ...(name
        ? [{ label: name, to: location.pathname + location.search, state: { ...location.state, from: undefined } }]
        : []),
    ],
    [shown, name, location],
  );

  return (
    <PagerSlotContext value={pager}>
      <TrailContext value={here}>
        <div className="nx-page" data-testid="page">
          <Breadcrumbs trail={shown} />
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
      </TrailContext>
    </PagerSlotContext>
  );
}
