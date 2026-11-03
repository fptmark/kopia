package server

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/repo/maintenance"
	"github.com/kopia/kopia/repo/maintenancestats"
)

func TestHumanizeMaintenanceWords(t *testing.T) {
	cases := map[string]string{
		"snapshot-gc":           "Snapshot GC",
		"full-rewrite-contents": "Full Rewrite Contents",
		"quick-delete-blobs":    "Quick Delete Blobs",
		"index-compaction":      "Index Compaction",
	}

	for in, want := range cases {
		require.Equal(t, want, humanizeMaintenanceWords(in, "-"), "input %q", in)
	}
}

func TestHumanizeMaintenanceFieldName(t *testing.T) {
	cases := map[string]string{
		"unreferencedContentCount": "Unreferenced Content Count",
		"unreferencedContentSize":  "Unreferenced Content Size",
		"wasAdvanced":              "Was Advanced",
		"epoch":                    "Epoch",
	}

	for in, want := range cases {
		require.Equal(t, want, humanizeMaintenanceFieldName(in), "input %q", in)
	}
}

func TestMaintenanceStatsCountersDecodesTheLatestSuccessfulRunPerTaskType(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)

	runStart := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)

	gcStats := &maintenancestats.SnapshotGCStats{
		UnreferencedContentCount: 71728,
		UnreferencedContentSize:  5700000000,
		InUseContentCount:        1161504,
	}
	gcExtra, err := maintenancestats.BuildExtra(gcStats)
	require.NoError(t, err)

	schedule := &maintenance.Schedule{
		Runs: map[maintenance.TaskType][]maintenance.RunInfo{
			maintenance.TaskSnapshotGarbageCollection: {
				{
					Start:   runStart.Add(time.Minute), // during this run
					End:     runStart.Add(2 * time.Minute),
					Success: true,
					Extra:   []maintenancestats.Extra{gcExtra},
				},
				{
					// an older, superseded run -- must not win over the newer one above
					Start:   runStart.Add(-time.Hour),
					Success: true,
				},
			},
			maintenance.TaskCleanupLogs: {
				{
					// stale: started before this maintenance invocation, so excluded entirely
					Start:   runStart.Add(-time.Minute),
					Success: true,
					Extra:   []maintenancestats.Extra{mustExtra(t, &maintenancestats.CleanupLogsStats{DeletedBlobCount: 3})},
				},
			},
			maintenance.TaskIndexCompaction: {
				{
					// failed: excluded even though it's recent
					Start:   runStart.Add(time.Minute),
					Success: false,
					Extra:   []maintenancestats.Extra{mustExtra(t, &maintenancestats.CompactIndexesStats{})},
				},
			},
		},
	}

	require.NoError(t, maintenance.SetSchedule(ctx, env.RepositoryWriter, schedule))

	counters := maintenanceStatsCounters(ctx, env.RepositoryWriter, runStart)

	require.Equal(t, int64(71728), counters["Snapshot GC: Unreferenced Content Count"].Value)
	require.Empty(t, counters["Snapshot GC: Unreferenced Content Count"].Units)
	require.Equal(t, int64(5700000000), counters["Snapshot GC: Unreferenced Content Size"].Value)
	require.Equal(t, "bytes", counters["Snapshot GC: Unreferenced Content Size"].Units)
	require.Equal(t, int64(1161504), counters["Snapshot GC: In Use Content Count"].Value)

	require.NotContains(t, counters, "Cleanup Logs: Deleted Blob Count")
	require.NotContains(t, counters, "Index Compaction: Dropped Contents Deleted Before")
}

func mustExtra(t *testing.T, s maintenancestats.Kind) maintenancestats.Extra {
	t.Helper()

	e, err := maintenancestats.BuildExtra(s)
	require.NoError(t, err)

	return e
}

func TestMaintenanceCycleLabel(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)

	owner := env.RepositoryWriter.ClientOptions().UsernameAtHost()

	params := maintenance.DefaultParams()
	params.Owner = owner
	require.NoError(t, maintenance.SetParams(ctx, env.RepositoryWriter, &params))

	now := env.RepositoryWriter.Time()

	// full is due
	require.NoError(t, maintenance.SetSchedule(ctx, env.RepositoryWriter, &maintenance.Schedule{
		NextFullMaintenanceTime:  now.Add(-time.Minute),
		NextQuickMaintenanceTime: now.Add(time.Hour),
	}))
	require.Equal(t, "GC", maintenanceCycleLabel(ctx, env.RepositoryWriter))

	// only quick is due
	require.NoError(t, maintenance.SetSchedule(ctx, env.RepositoryWriter, &maintenance.Schedule{
		NextFullMaintenanceTime:  now.Add(time.Hour),
		NextQuickMaintenanceTime: now.Add(-time.Minute),
	}))
	require.Equal(t, "quick", maintenanceCycleLabel(ctx, env.RepositoryWriter))

	// neither due
	require.NoError(t, maintenance.SetSchedule(ctx, env.RepositoryWriter, &maintenance.Schedule{
		NextFullMaintenanceTime:  now.Add(time.Hour),
		NextQuickMaintenanceTime: now.Add(time.Hour),
	}))
	require.Equal(t, "periodic", maintenanceCycleLabel(ctx, env.RepositoryWriter))
}
