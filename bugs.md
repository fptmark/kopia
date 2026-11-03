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

- [ ] The "Future" tab (/api/v1/tasks/upcoming, internal/server/api_tasks_upcoming.go:41)
      shows a misleading next time when an earlier scheduled snapshot is still pending and
      deferred (e.g. by the sleep/wake instability window). It calls
      `eff.SchedulingPolicy.NextSnapshotTime(now, now)` -- a standalone "next clean slot
      from right now" projection with no knowledge of the real source manager's actual
      pending target or live deferral state. Confirmed concretely: at 08:09 the real
      pending target (/api/v1/sources' nextSnapshotTime) was still the overdue 08:00 slot,
      correctly held back by a fresh sleep/wake instability window (log: "last check was
      1h51m5s ago (machine asleep?)"), while the Future tab was already showing 09:00 as
      next -- implying the 8am run was skipped when it was actually still owed and about
      to fire late. Fix direction: this display should reflect the real pending/deferred
      target, not recompute independently from "now".

## Done

- [x] Persistent local code-signing certificate ("Kopia Local Signing", self-signed,
      Code Signing EKU, trusted for codeSign in the login keychain) now used instead of
      ad-hoc signing (`--sign -`). Verified: CDHash is identical across repeated
      `make install-server` runs now, where it previously changed on every single rebuild.
      This is the actual, researched root cause fix for the repeated Full Disk Access
      revocations tonight -- not a guess, confirmed via multiple independent reports of the
      same issue in other projects.
      Fully confirmed working, including the case that was unverified when first deployed:
      after one remove-and-re-add of the FDA grant (a stale stored code-requirement needed
      that, not just a toggle) and a relaunch, the 138/139 "operation not permitted"
      errors (AddressBook, CallHistoryDB, CloudDocs, FaceTime, Calendars, com.apple.TCC,
      etc.) are gone -- confirmed numFailed=0 on a snapshot that ran after a real
      code-change rebuild (the wake-grace-preference change), not just a no-op rebuild.
      That was the actual open question; it's answered. Grants now survive real rebuilds.
