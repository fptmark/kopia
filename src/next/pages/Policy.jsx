import React, { useCallback, useEffect, useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import { useLocation, useNavigate } from "react-router";
import { policyEditorURL, PolicyTypeName, sourceQueryStringParams } from "../../utils/policyutil";
import { api, errorMessage } from "../api";
import { useLoad } from "../hooks";
import { cleanPolicy, setPath } from "../policy/helpers";
import { PolicyFields } from "../policy/PolicyFields";
import { PolicyTargetPicker, sourceRelationship } from "../policy/PolicyTargetPicker";
import { usePolicy } from "../policy/usePolicy";
import { sourceString } from "../snapshots";
import { CliCommand, ConfirmDialog, Loading, Notice, Page } from "../ui";

function targetFromSearch(search) {
  const q = new URLSearchParams(search);
  return { host: q.get("host") ?? "", userName: q.get("userName") ?? "", path: q.get("path") ?? "" };
}

/**
 * The breadcrumb trail for a path-type target: Policies, the owning source, then one crumb per subfolder
 * segment -- every ancestor a link back to its own policy, the last one the current page. A path that is a
 * source's own root, or isn't under any known source, gets just itself after Policies.
 */
function pathTrail(base, target, owner, isSourceRoot) {
  if (isSourceRoot || !owner) {
    return [...base, { label: target.path }];
  }
  const rest = target.path
    .slice(owner.path.length)
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  const crumbs = [{ label: owner.path, to: policyEditorURL(owner) }];
  rest.forEach((seg, i) => {
    const last = i === rest.length - 1;
    const path = owner.path + "/" + rest.slice(0, i + 1).join("/");
    crumbs.push(last ? { label: seg } : { label: seg, to: policyEditorURL({ ...owner, path }) });
  });
  return [...base, ...crumbs];
}

/**
 * The settings of one policy: what it says, and what ends up in effect for it. Reached either with a real
 * target (from the Policies list, or from this page's own "Policy for" source picker) or with none at all (the
 * "Add a policy" button) -- which still shows every tab, just against a draft with nothing to resolve yet, so
 * picking a source below is the only thing Save is waiting on.
 */
export function Policy() {
  const location = useLocation();
  const navigate = useNavigate();
  const target = targetFromSearch(location.search);
  // No query string at all (as opposed to one with every part empty, which is the global policy on purpose):
  // no source picked yet.
  const isNewPick = location.search === "";
  const state = usePolicy(target, { enabled: !isNewPick });
  const sourcesState = useLoad(() => api.get("/api/v1/sources").then((r) => r.data), []);
  const algorithmsState = useLoad(() => api.get("/api/v1/repo/algorithms").then((r) => r.data), [], {
    enabled: isNewPick,
  });

  const [draftPolicy, setDraftPolicy] = useState({});
  const draftChange = useCallback((path, value) => setDraftPolicy((p) => setPath(p, path, value)), []);
  const draftDirty = useMemo(() => {
    try {
      return Object.keys(cleanPolicy(draftPolicy)).length > 0;
    } catch {
      return true; // a time of day still being typed counts as a change
    }
  }, [draftPolicy]);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // picked from the blank "Add policy" start, but it turned out this source already has one
  const [switchedToExisting, setSwitchedToExisting] = useState(false);
  useEffect(() => {
    if (location.state?.fromAdd && state.loaded && !state.isNew) {
      setSwitchedToExisting(true);
    }
  }, [location.state, state.loaded, state.isNew]);
  const isGlobal = !isNewPick && !target.host && !target.userName && !target.path;
  const sources = sourcesState.data?.sources?.map((r) => r.source) ?? [];
  const { owner, isSourceRoot } = sourceRelationship(target, sources);
  const hideSourceOnly = !!target.path && !isSourceRoot;

  const base = [{ label: "Policies", to: "/policies" }];
  const trail = isNewPick ? [...base, { label: "New policy" }] : target.path ? pathTrail(base, target, owner, isSourceRoot) : base;

  // dirty stays false while there is no target to save against yet -- the "Add policy" draft before a source
  // is picked has nothing Page can save, and saveDisabledReason explains the disabled button instead.
  const dirty = !isNewPick && state.loaded && (state.dirty || state.isNew);

  const onSave = () => {
    state.valid(); // throws, synchronously, with what's wrong
    return state.save().then(() => navigate(-1));
  };

  const doDelete = () => {
    setDeleting(true);
    setDeleteError(null);
    state.remove().then(
      () => navigate(-1),
      (e) => {
        setDeleting(false);
        setDeleteError("Not deleted: " + errorMessage(e));
      },
    );
  };

  return (
    <Page
      title={isNewPick ? "New policy" : PolicyTypeName(target)}
      trail={trail}
      crumb="Policy"
      dirty={dirty}
      onSave={onSave}
      saveLabel="Save policy"
      saveDisabledReason={isNewPick ? "Pick a source below first" : undefined}
      actions={
        !isNewPick &&
        !state.isNew && (
          <Button
            variant="danger"
            disabled={isGlobal || deleting}
            onClick={() => setConfirmDelete(true)}
            title={isGlobal ? "The global policy cannot be deleted" : undefined}
          >
            Delete policy
          </Button>
        )
      }
    >
      {deleteError && (
        <Notice kind="error" onClose={() => setDeleteError(null)}>
          {deleteError}
        </Notice>
      )}
      {(isNewPick || target.path) && !sourcesState.data && <Loading />}
      {(isNewPick || target.path) && sourcesState.data && (
        <PolicyTargetPicker
          target={target}
          sources={sources}
          showCombo={isNewPick}
          onPick={(t) => navigate(policyEditorURL(t), isNewPick ? { state: { fromAdd: true } } : undefined)}
        />
      )}
      {!isNewPick && state.error && <Notice kind="error">{state.error}</Notice>}
      {!isNewPick && !state.loaded && !state.error && <Loading />}
      {isNewPick && (
        <PolicyFields
          target={target}
          policyState={{
            policy: draftPolicy,
            change: draftChange,
            resolved: null,
            algorithms: algorithmsState.data,
            loaded: true,
            isNew: true,
            dirty: draftDirty,
          }}
        />
      )}
      {!isNewPick && state.loaded && (!target.path || sourcesState.data) && (
        <>
          <PolicyFields
            key={sourceQueryStringParams(target)}
            target={target}
            policyState={state}
            hideSourceOnly={hideSourceOnly}
          />
        </>
      )}
      {!isNewPick && <CliCommand command={`policy set "${sourceString(target)}"`} />}

      <ConfirmDialog
        show={confirmDelete}
        title="Delete this policy?"
        confirmLabel="Delete"
        danger
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={doDelete}
      >
        Settings it defines fall back to the policies above it.
      </ConfirmDialog>

      <Modal show={switchedToExisting} onHide={() => setSwitchedToExisting(false)}>
        <Modal.Header closeButton>
          <Modal.Title as="h2" className="fs-5">
            Switching to edit mode
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>Policy exists for this source — switching to edit mode.</Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={() => setSwitchedToExisting(false)}>
            Got it
          </Button>
        </Modal.Footer>
      </Modal>
    </Page>
  );
}
