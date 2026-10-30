import React, { useState } from "react";
import { ownerName } from "../snapshots";
import { Notice } from "../ui";
import { SourceCombo } from "./SourceCombo";

const SEP = "/";

function isUnder(path, parent) {
  return path === parent || path.startsWith(parent.endsWith(SEP) ? parent : parent + SEP);
}

const sameOwner = (a, b) => ownerName(a) === ownerName(b);

/**
 * Which of `sources` a path belongs to: the one whose own path is a prefix of it, picking the longest match so
 * a source nested inside another still resolves to its own, more specific, source. Returns {owner, isSourceRoot}.
 */
export function sourceRelationship(target, sources) {
  if (!target.path) {
    return { owner: undefined, isSourceRoot: false };
  }
  const owner = sources
    .filter((s) => sameOwner(s, target) && isUnder(target.path, s.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return { owner, isSourceRoot: !!owner && owner.path === target.path };
}

/**
 * The editor's own "Policy for" row. Before a source is picked (showCombo), it's a SourceCombo to pick one.
 * Once bound to a real target, the source can't be switched out from under the policy you're editing -- the
 * combo goes away, leaving only Browse (still the same source, just a deeper folder of it) and the status
 * banner; the breadcrumb trail above (Page's own trail, set by the caller) is how you move between related
 * levels. Picking anything calls onPick with the new {userName, host, path} target.
 */
export function PolicyTargetPicker({ target, sources, onPick, showCombo = false }) {
  const [browseError, setBrowseError] = useState("");
  const { owner, isSourceRoot } = sourceRelationship(target, sources);
  const showBrowse = !!owner && !!window.kopiaUI;

  const browse = () => {
    setBrowseError("");
    window.kopiaUI.selectDirectory((picked) => {
      if (!picked) {
        return;
      }
      if (!isUnder(picked, owner.path)) {
        setBrowseError(`Pick a folder inside ${owner.path}.`);
        return;
      }
      onPick({ userName: owner.userName, host: owner.host, path: picked });
    }, target.path || owner.path);
  };

  return (
    <div className="nx-stack">
      {(showCombo || showBrowse) && (
        <div className="nx-row nx-policy-picker">
          {showCombo && (
            <>
              <span className="nx-muted">Policy for</span>
              <SourceCombo
                sources={sources}
                value={target.path}
                onPick={(s) => onPick({ userName: s.userName, host: s.host, path: s.path })}
              />
            </>
          )}
          {showBrowse && (
            <button type="button" className="btn btn-link btn-sm" onClick={browse}>
              Browse…
            </button>
          )}
        </div>
      )}
      {browseError && <Notice kind="error">{browseError}</Notice>}
      {target.path &&
        !isSourceRoot &&
        (owner ? (
          <Notice kind="info">
            This is a subfolder of your source <span className="nx-path">{owner.path}</span>. File-handling
            settings here override that source&rsquo;s for this folder and everything under it. Scheduling,
            retention, upload and verify stay controlled by the source itself.
          </Notice>
        ) : (
          <Notice kind="warning">
            {target.path} isn&rsquo;t part of any of your sources. Nothing set here takes effect right now.
          </Notice>
        ))}
    </div>
  );
}
