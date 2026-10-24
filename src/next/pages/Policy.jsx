import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import { useLocation, useNavigate } from "react-router";
import { PolicyTypeName } from "../../utils/policyutil";
import { errorMessage } from "../api";
import { PolicyFields } from "../policy/PolicyFields";
import { usePolicy } from "../policy/usePolicy";
import { CliCommand, ConfirmDialog, Loading, Notice, Page } from "../ui";

function targetFromSearch(search) {
  const q = new URLSearchParams(search);
  return { host: q.get("host") ?? "", userName: q.get("userName") ?? "", path: q.get("path") ?? "" };
}

/** The settings of one policy: what it says, and what ends up in effect for it. */
export function Policy() {
  const location = useLocation();
  const navigate = useNavigate();
  const target = targetFromSearch(location.search);
  const state = usePolicy(target);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isGlobal = !target.host && !target.userName && !target.path;

  const run = (promise, failure) => {
    setSaving(true);
    promise
      .then(() => navigate(-1))
      .catch((e) => {
        setSaving(false);
        setMessage(failure + errorMessage(e));
      });
  };

  const save = () => {
    try {
      state.valid();
    } catch (e) {
      setMessage(e.message);
      return;
    }
    run(state.save(), "Not saved: ");
  };

  return (
    <Page
      title={PolicyTypeName(target)}
      back="/policies"
      backLabel="Policies"
      actions={
        <>
          {!state.isNew && (
            <Button
              variant="danger"
              disabled={isGlobal || saving}
              onClick={() => setConfirmDelete(true)}
              title={isGlobal ? "The global policy cannot be deleted" : undefined}
            >
              Delete policy
            </Button>
          )}
          <Button
            variant="primary"
            disabled={saving || !state.loaded || (!state.dirty && !state.isNew)}
            onClick={save}
            data-testid="button-save"
          >
            Save policy
          </Button>
        </>
      }
    >
      {message && (
        <Notice kind="error" onClose={() => setMessage(null)}>
          {message}
        </Notice>
      )}
      {state.error && <Notice kind="error">{state.error}</Notice>}
      {!state.loaded && !state.error && <Loading />}
      {state.loaded && (
        <>
          {state.isNew && (
            <Notice kind="info">
              This policy does not exist yet. Settings you leave empty follow the policies above it.
            </Notice>
          )}
          <PolicyFields target={target} policyState={state} />
        </>
      )}
      <CliCommand command={`policy set "${target.userName}@${target.host}:${target.path}"`} />

      <ConfirmDialog
        show={confirmDelete}
        title="Delete this policy?"
        confirmLabel="Delete"
        danger
        busy={saving}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => run(state.remove(), "Not deleted: ")}
      >
        Settings it defines fall back to the policies above it.
      </ConfirmDialog>
    </Page>
  );
}
