package server_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/apiclient"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/servertesting"
	"github.com/kopia/kopia/internal/testlogging"
	"github.com/kopia/kopia/internal/testutil"
	"github.com/kopia/kopia/snapshot/policy"
)

func TestUpcomingTasks(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	srvInfo := servertesting.StartServer(t, env, false)

	cli, err := apiclient.NewKopiaAPIClient(apiclient.Options{
		BaseURL:                             srvInfo.BaseURL,
		TrustedServerCertificateFingerprint: srvInfo.TrustedServerCertificateFingerprint,
		Username:                            servertesting.TestUIUsername,
		Password:                            servertesting.TestUIPassword,
	})
	require.NoError(t, err)
	require.NoError(t, cli.FetchCSRFTokenForTesting(ctx))

	// one source snapshots hourly and never verifies; a second has no schedule at all and must not appear.
	mustCreateSource(t, cli, testutil.TempDirectory(t), &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600},
	})
	mustCreateSource(t, cli, testutil.TempDirectory(t), &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{Manual: true},
	})

	resp, err := serverapi.UpcomingTasks(testlogging.Context(t), cli, 5)
	require.NoError(t, err)
	require.Len(t, resp.Tasks, 5)

	for i, task := range resp.Tasks {
		require.Equal(t, "Snapshot", task.Kind)

		if i > 0 {
			require.False(t, task.Time.Before(resp.Tasks[i-1].Time), "tasks must come back soonest first")
		}
	}
}
