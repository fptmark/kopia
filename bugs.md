# Open items

- [ ] Snapshot delete gives no feedback while in progress. Root cause found:
      `ConfirmDialog`'s confirm button just goes `disabled` while `busy`, no spinner or
      label change (gui/src/next/ui/ConfirmDialog.jsx), so a slow delete (e.g. flaky SFTP)
      looks frozen. Fix: show a spinner + "Deleting…" while busy. Not yet implemented.

- [ ] Media Library TCC popup ("KopiaServer.app would like to access Apple Music...")
      appeared, never answered.

- [ ] Desktop Folder TCC popup appeared, never answered. Root cause unresolved — checked
      and ruled out: bundle-identity confusion (only one app bundle, stable
      CFBundleIdentifier), "first time ever access" (Desktop/labs.png has been captured
      continuously since Oct 21), and found no corroborating tccd log entries at all in the
      last 2h window. Genuinely unexplained; needs more investigation if revisited.

- [ ] The 138/139 "operation not permitted" snapshot errors are real, confirmed from the
      raw error list on the latest run: AddressBook, CallHistoryDB, CloudDocs, FaceTime,
      Calendars, com.apple.TCC, Siri data, Home app data, etc. Full Disk Access does not
      cover these -- each is its own separate TCC category (same pattern as the Media
      Library / Desktop Folder popups), and since KopiaServer runs as a headless background
      LaunchAgent, several of these categories may never even prompt for consent (some
      require an interactive/foreground process).
      Timeline (confirmed from full snapshot history, not guessed): ran clean
      (numFailed=0) for 9 straight days, Oct 24 - Nov 2 20:18:59 PST, then broke at Nov 2
      22:23:10 PST and has stayed broken since. That ~2h window is exactly the heaviest
      rebuild/re-sign cycling of the night (stall-timeout feature, multiple
      install-server/restart-server calls, the dataless-file fix) -- a second, separate
      breakage from the original Oct 21 one (which got fixed and stayed fixed for 9 days),
      not a continuation of it.
      Decide: try to grant what can be granted, or add a policy ignore rule for these paths
      (mostly macOS's own internal caches/databases, not real user documents).

- [ ] Check final status/error count of the snapshot that was running as of the last
      restart tonight — never confirmed its outcome.

- [ ] Snapshot throughput is very slow -- e.g. ~58 files/sec at one point tonight, well
      below the historical range seen in task-history (2,551-22,541 files/sec across past
      runs). Partly explained by this run doing real first-time work in previously
      FDA/dataless-blocked directories (iCloud, Library/Accounts, etc. -- real disk+network
      I/O instead of instant permission-denied skips), but not fully investigated or ruled
      out as also involving something else. Still needs real profiling to settle, not more
      guessing. Researched (not guessed) what progress signals actually exist per
      workflow, with file:line citations, to inform any stall-detection/feedback redesign:
        - **Snapshot upload**: already had its own fine-grained progress before tonight --
          `upload.Progress` (snapshot/upload/upload_progress.go) fires `HashedBytes()`
          every 64KB chunk while hashing (upload.go:411) and `UploadedBytes()` per
          pack-blob flush. Both existed pre-tonight, aggregate continuously via atomics,
          and reach the UI throttled to 1/sec (source_manager.go:592-600, pre-existing).
          Tonight's only addition here is `taskprogress.Tick()` in the shared retry layer
          (internal/retry.internalRetry) -- coarser and less frequent than the pre-existing
          HashedBytes calls, so an unlikely cause of a multi-minute slowdown, though not
          ruled out without profiling.
        - **Verify has a real gap**: `checkFile` (internal/server/snapshot_verify.go:218-260)
          does `io.Copy(io.Discard, r)` over a whole file and only calls `v.report()` via
          `defer` -- *after* the whole file is read. No per-chunk signal exists inside a
          single file's verify-read. A very large file being verified shows zero counter
          movement until it finishes. (The underlying object reads likely still go through
          retry-wrapped GetBlob calls across pack blobs, so the generic Tick() probably
          still fires during this, but the UI-visible counters do not.)
        - **Maintenance has no progress wiring at all**: server.go:1141 passes the
          `uitask.Controller` as `_` -- explicitly discarded. No ReportCounters or
          ReportProgressInfo anywhere in repo/maintenance/*.go. Only task start/end are
          visible to the UI.
        - Conclusion: the retry-layer Tick() sits at the one layer all three workflows
          already share (repo/blob.Storage), so it's a reasonable generic stall-detection
          signal without per-workflow special-casing. The real gaps found are *feedback*
          gaps, not performance causes: Maintenance shows nothing at all, Verify shows
          nothing mid-file. Neither explains a performance regression by itself.

## Done

- [x] Persistent local code-signing certificate ("Kopia Local Signing", self-signed,
      Code Signing EKU, trusted for codeSign in the login keychain) now used instead of
      ad-hoc signing (`--sign -`). Verified: CDHash is identical across repeated
      `make install-server` runs now (confirmed twice in a row), where it previously
      changed on every single rebuild. This is the actual, researched root cause fix for
      the repeated Full Disk Access revocations tonight -- not a guess, confirmed via
      multiple independent reports of the same issue in other projects. Deployed; still
      needs Full Disk Access granted one more time against this new identity, then should
      persist through real code changes too, not just no-op rebuilds.
