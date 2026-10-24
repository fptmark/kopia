package server

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/exclusion"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

func TestExclusionHealthCheckWaitsForTheRulesToBeApplied(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)

	home := env.LocalPathSourceInfo("/home")

	require.NoError(t, repo.WriteSession(ctx, env.Repository, repo.WriteSessionOptions{Purpose: "Test"}, func(ctx context.Context, w repo.RepositoryWriter) error {
		g := &policy.Policy{}
		g.FilesPolicy.IgnoreRules = []string{"node_modules/"}

		if err := policy.SetPolicy(ctx, w, policy.GlobalPolicySourceInfo, g); err != nil {
			return err
		}

		h := &policy.Policy{}
		h.FilesPolicy.IgnoreRules = []string{"/milo.db-wal"}

		return policy.SetPolicy(ctx, w, home, h)
	}))

	store, err := exclusion.Open(filepath.Join(t.TempDir(), "rules.json"), time.Now)
	require.NoError(t, err)

	srv := &Server{exclusions: store}

	// nothing is set up yet: no check
	_, ok := srv.exclusionCheck(ctx, env.Repository)
	require.False(t, ok)

	require.NoError(t, srv.ensureExclusionsImported(ctx, env.Repository))

	// /home does not follow the global rule, but nothing has been applied, so that is not a failure
	c, ok := srv.exclusionCheck(ctx, env.Repository)
	require.True(t, ok)
	require.True(t, c.OK, c.Detail)
	require.Contains(t, c.Detail, "not applied")

	_, err = srv.applyExclusions(ctx, env.Repository, []snapshot.SourceInfo{home}, true)
	require.NoError(t, err)

	c, _ = srv.exclusionCheck(ctx, env.Repository)
	require.True(t, c.OK, c.Detail)
	require.Contains(t, c.Detail, "in force")

	// once applied, a policy that drifts away from the rules is a problem
	g, err := policy.GetDefinedPolicy(ctx, env.Repository, policy.GlobalPolicySourceInfo)
	require.NoError(t, err)

	g.FilesPolicy.IgnoreRules = nil

	require.NoError(t, repo.WriteSession(ctx, env.Repository, repo.WriteSessionOptions{Purpose: "Test"}, func(ctx context.Context, w repo.RepositoryWriter) error {
		return policy.SetPolicy(ctx, w, policy.GlobalPolicySourceInfo, g)
	}))

	c, _ = srv.exclusionCheck(ctx, env.Repository)
	require.False(t, c.OK)
	require.Contains(t, c.Detail, "missing")
}
