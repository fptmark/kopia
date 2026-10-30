import React, { useCallback, useEffect, useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import { useBlocker, useLocation } from "react-router";
import { errorMessage } from "../api";
import { Breadcrumbs } from "./Breadcrumbs";
import { ConfirmDialog } from "./ConfirmDialog";
import { Notice } from "./Feedback";
import { PagerSlotContext } from "./PagerSlot";
import { TrailContext } from "./TrailContext";

/**
 * The frame every page uses: breadcrumbs, optional title with a line under it, and actions on the right.
 *
 * trail is the page's own place: [{label, to?, state?}] from the top down, an item without `to` being the page
 * itself. Pages opened from another page with a FromLink show that page's trail instead,
 * then themselves; crumb names the page in that trail when the title is not what it should be called.
 *
 * Passing onSave turns on the page's save handling: a Save button appears in the actions row (enabled only
 * while dirty), saving and its errors are tracked here instead of per page, and navigating away (in app, or
 * closing/reloading the tab) while dirty asks for confirmation first. onDiscard, if given, runs when the user
 * confirms leaving without saving (to drop a local draft). saveDisabledReason explains a disabled Save button
 * (e.g. "Pick a source below first") when dirty alone would not say why.
 */
export function Page({
  title,
  subtitle,
  trail,
  crumb,
  actions,
  children,
  dirty = false,
  onSave,
  onDiscard,
  saveLabel = "Save",
  savingLabel = "Saving…",
  saveDisabledReason,
}) {
  const [slot, setSlot] = useState(null);
  const pager = useMemo(() => ({ slot, setSlot }), [slot]);
  const location = useLocation();
  const hasSave = typeof onSave === "function";

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // saving suppresses the blocker too: a page's own onSave often navigates away on success, and that
  // navigation should not trip the very guard the save was supposed to satisfy. Only a change of pathname
  // counts as leaving -- a tab switch or filter that only changes the query string stays on the same page,
  // and the draft (and dirty state) survives that on its own.
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        hasSave && dirty && !saving && currentLocation.pathname !== nextLocation.pathname,
      [hasSave, dirty, saving],
    ),
  );

  useEffect(() => {
    if (!hasSave || !dirty) {
      return undefined;
    }
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasSave, dirty]);

  const fail = (e) => {
    setSaving(false);
    setError("Not saved: " + errorMessage(e));
  };

  const save = () => {
    setError(null);
    setSaving(true);
    // onSave may validate synchronously and throw (rather than return a rejected promise) before it gets to
    // anything async, e.g. a policy that fails cleanPolicy()'s checks -- Promise.resolve(onSave()) alone
    // would let that throw escape the click handler instead of landing in the error Notice below.
    let result;
    try {
      result = onSave();
    } catch (e) {
      fail(e);
      return;
    }
    Promise.resolve(result).then(() => setSaving(false), fail);
  };

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
          {(title || actions || hasSave) && (
            <div className="nx-page-header">
              <div>
                {title && <h1 className="nx-page-title">{title}</h1>}
                {subtitle && <div className="nx-page-subtitle">{subtitle}</div>}
              </div>
              {(actions || hasSave) && (
                <div className="nx-page-actions">
                  {actions}
                  {hasSave && (
                    <Button
                      variant="primary"
                      disabled={!dirty || saving}
                      onClick={save}
                      data-testid="button-save"
                      title={!dirty ? saveDisabledReason : undefined}
                    >
                      {saving ? savingLabel : saveLabel}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {error && (
            <Notice kind="error" onClose={() => setError(null)}>
              {error}
            </Notice>
          )}
          {children}
          <ConfirmDialog
            show={blocker.state === "blocked"}
            title="Leave without saving?"
            confirmLabel="Leave without saving"
            danger
            onCancel={() => blocker.reset()}
            onConfirm={() => {
              onDiscard?.();
              blocker.proceed();
            }}
          >
            This page has changes that have not been saved.
          </ConfirmDialog>
        </div>
      </TrailContext>
    </PagerSlotContext>
  );
}
