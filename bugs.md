# Open items

- [ ] Snapshot delete gives no feedback while in progress. Root cause found:
      `ConfirmDialog`'s confirm button just goes `disabled` while `busy`, no spinner or
      label change (gui/src/next/ui/ConfirmDialog.jsx), so a slow delete (e.g. flaky SFTP)
      looks frozen. Fix: show a spinner + "Deleting…" while busy. Not yet implemented.

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

- [x] Media Library and Desktop Folder TCC popups ("KopiaServer.app would like to
      access...") have stopped appearing — user confirmed as of 2026-11-03. Root cause was
      never independently confirmed for these two specifically (unlike the Full Disk Access
      case, where the stale-code-requirement / ad-hoc-signing-churn fix was proven with
      numFailed=0 before and after). Most likely the same stable code-signing cert fix
      resolved them too, since ad-hoc re-signing on every rebuild would churn every TCC
      category's grant identity, not just FDA's — but that's a plausible explanation, not a
      verified one. Reopen if they come back.

- [x] Scoped how much of the codebase is macOS-specific, ahead of a possible per-OS driver
      architecture. Diffed `custom` against real upstream `kopia/master` and audited the
      deploy layer. Findings:
        - **Go backend is already abstracted** -- every OS-specific behavior (keep-awake via
          `caffeinate`, iCloud/cloud-placeholder detection via `SF_DATALESS`, AppleScript/
          iMessage/Mail notifications, plus upstream's own password-prompt/mount/path/
          tempfile handling) already follows Go's native build-tag driver pattern: a shared
          interface file + `*_darwin.go` + `*_other.go`/`*_windows.go`/`*_linux.go`. ~23
          files total. No new framework needed here -- a hand-rolled interface/registry
          would just reinvent what `//go:build` already gives for free.
        - **The install/service layer is the one unabstracted, 100%-macOS-only part**: the
          root `Makefile` (codesign with the stable local cert, `launchctl bootout`/
          `bootstrap` against `setup/launchd/*.plist`) and TCC/Full Disk Access itself, which
          has no Linux/Windows equivalent to abstract *to*. ~80 lines, no plans to touch
          unless/until a second OS target is real -- then it's a second install script
          (systemd unit on Linux, Windows Service on Windows) picked by `uname`, not a
          redesign.
        - **One real driver gap, not a framework gap**: `local_fs_dataless_other.go` (used
          for Linux and Windows alike) is a no-op stub, correct for Linux (no OS concept to
          detect) but a genuine blind spot on Windows -- OneDrive/cloud-sync placeholders
          are real and detectable there via `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`/
          `RECALL_ON_OPEN`, just through a completely different mechanism than macOS's
          `st_flags` bit. Would need its own `local_fs_dataless_windows.go` if ever needed;
          not written, no current Windows target.

- [x] The "Future" tab's first entry per source now comes from the source manager's own
      live `getNextSnapshotTime()`/`getNextVerifyTime()` (which already reflects actual
      last completion, sleep/wake deferral, and the too-soon suppression) instead of a
      blind `SchedulingPolicy.NextSnapshotTime(now, now)` recompute that had no idea an
      earlier slot was still overdue-and-pending. Verified live: with the real pending
      target at 09:00 for one source and 12:00 for another (/api/v1/sources'
      nextSnapshotTime), the Future tab's first entries now match exactly. Only the first
      entry per source/kind can be made honest this way -- the source manager tracks just
      the one next target, not a run of future ones -- so entries after it still project
      the policy forward, same as before.

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
