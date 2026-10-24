package server_test

import (
	"context"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/apiclient"
	"github.com/kopia/kopia/internal/mockfs"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/servertesting"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
	"github.com/kopia/kopia/snapshot/upload"
)

type exclusionsResp struct {
	Rules []struct {
		ID      string `json:"id"`
		Source  string `json:"source"`
		Pattern string `json:"pattern"`
		AddedBy string `json:"addedBy"`
	} `json:"rules"`
	Removed []struct {
		Pattern string `json:"pattern"`
	} `json:"removed"`
	Sources []struct {
		Path   string `json:"path"`
		Own    int    `json:"ownRules"`
		Net    int    `json:"netRules"`
		InSync bool   `json:"inSync"`
	} `json:"sources"`
	Drift []struct {
		Target  string   `json:"target"`
		Missing []string `json:"missing"`
		Extra   []string `json:"extra"`
	} `json:"drift"`
	Imported bool `json:"imported"`
}

type addResp struct {
	Added []struct {
		ID      string `json:"id"`
		Pattern string `json:"pattern"`
	} `json:"added"`
	Existing []struct {
		Pattern string `json:"pattern"`
	} `json:"existing"`
	Changes []struct {
		Target string   `json:"target"`
		After  []string `json:"after"`
	} `json:"changes"`
	ApplyError string `json:"applyError"`
}

// exclusionsEnv has two sources with snapshots: /home (it gets its own ignore list, which hides the global
// one, the way a source policy does in real life) and /apps (which has no policy at all).
func exclusionsEnv(t *testing.T) (context.Context, *apiclient.KopiaAPIClient, *repotesting.Environment) {
	t.Helper()

	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)

	home := env.LocalPathSourceInfo("/home")
	apps := env.LocalPathSourceInfo("/apps")

	require.NoError(t, repo.WriteSession(ctx, env.Repository, repo.WriteSessionOptions{Purpose: "Test"}, func(ctx context.Context, w repo.RepositoryWriter) error {
		u := upload.NewUploader(w)

		d := mockfs.NewDirectory()
		d.AddFile("keep.txt", []byte{1}, 0o644)
		d.AddDir("node_modules", 0o755).AddFile("x.js", []byte{1, 2, 3}, 0o644)
		lib := d.AddDir("Library", 0o755)
		lib.AddDir("Caches", 0o755).AddFile("c", []byte{1, 2, 3, 4}, 0o644)
		lib.AddDir("build", 0o755).AddFile("q", []byte{9}, 0o644)

		p := d.AddDir("Projects", 0o755)
		a := p.AddDir("a", 0o755)
		a.AddDir("build", 0o755).AddFile("out", []byte{1, 1, 1, 1, 1}, 0o644)
		a.AddDir("node_modules", 0o755).AddFile("m.js", []byte{7, 7, 7, 7, 7, 7}, 0o644)
		p.AddDir("build", 0o755).AddFile("z", []byte{2, 2}, 0o644)

		for _, si := range []snapshot.SourceInfo{home, apps} {
			m, err := u.Upload(ctx, d, nil, si)
			if err != nil {
				return err
			}

			if _, err := snapshot.SaveSnapshot(ctx, w, m); err != nil {
				return err
			}
		}

		// global rules, and a home policy with a list of its own that hides them
		g := &policy.Policy{}
		g.FilesPolicy.IgnoreRules = []string{"node_modules/", ".Trash/"}

		if err := policy.SetPolicy(ctx, w, policy.GlobalPolicySourceInfo, g); err != nil {
			return err
		}

		h := &policy.Policy{}
		h.FilesPolicy.IgnoreRules = []string{"/milo.db-wal"}

		return policy.SetPolicy(ctx, w, home, h)
	}))

	srvInfo := servertesting.StartServer(t, env, false)

	cli, err := apiclient.NewKopiaAPIClient(apiclient.Options{
		BaseURL:                             srvInfo.BaseURL,
		TrustedServerCertificateFingerprint: srvInfo.TrustedServerCertificateFingerprint,
		Username:                            servertesting.TestUIUsername,
		Password:                            servertesting.TestUIPassword,
	})
	require.NoError(t, err)
	require.NoError(t, cli.FetchCSRFTokenForTesting(ctx))

	return ctx, cli, env
}

func effective(ctx context.Context, t *testing.T, env *repotesting.Environment, path string) []string {
	t.Helper()

	p, _, _, err := policy.GetEffectivePolicy(ctx, env.Repository, env.LocalPathSourceInfo(path))
	require.NoError(t, err)

	return p.FilesPolicy.IgnoreRules
}

func TestExclusionsImportDriftAndFix(t *testing.T) {
	ctx, cli, env := exclusionsEnv(t)

	var list exclusionsResp
	require.NoError(t, cli.Get(ctx, "exclusions", nil, &list))

	// the existing lists became rules: two global, one for /home
	require.True(t, list.Imported)
	require.Len(t, list.Rules, 3)
	require.Equal(t, "", list.Rules[0].Source)
	require.Equal(t, ".Trash/", list.Rules[0].Pattern)
	require.Equal(t, "import", list.Rules[0].AddedBy)
	require.Equal(t, "/home", list.Rules[2].Source)

	// /home does not follow the global rules: that is the drift
	require.Len(t, list.Drift, 1)
	require.Equal(t, "/home", list.Drift[0].Target)
	require.ElementsMatch(t, []string{".Trash/", "node_modules/"}, list.Drift[0].Missing)
	require.Empty(t, list.Drift[0].Extra)
	require.Equal(t, []string{"/milo.db-wal"}, effective(ctx, t, env, "/home"))

	// importing again changes nothing
	require.NoError(t, cli.Get(ctx, "exclusions", nil, &list))
	require.Len(t, list.Rules, 3)

	var fixed struct {
		Changes []struct {
			Target string   `json:"target"`
			After  []string `json:"after"`
		} `json:"changes"`
	}

	require.NoError(t, cli.Post(ctx, "exclusions/reconcile", map[string]any{}, &fixed))
	require.Len(t, fixed.Changes, 1)
	require.Equal(t, "/home", fixed.Changes[0].Target)
	require.ElementsMatch(t, []string{"/milo.db-wal", ".Trash/", "node_modules/"}, effective(ctx, t, env, "/home"))

	// /apps has no policy of its own and follows the global one, so no policy was created for it
	require.ElementsMatch(t, []string{".Trash/", "node_modules/"}, effective(ctx, t, env, "/apps"))

	_, err := policy.GetDefinedPolicy(ctx, env.Repository, env.LocalPathSourceInfo("/apps"))
	require.ErrorIs(t, err, policy.ErrPolicyNotFound)

	require.NoError(t, cli.Get(ctx, "exclusions", nil, &list))
	require.Empty(t, list.Drift)

	// a second fix writes nothing
	require.NoError(t, cli.Post(ctx, "exclusions/reconcile", map[string]any{}, &fixed))
	require.Empty(t, fixed.Changes)
}

func TestExclusionsAddAndRemoveAreAppliedAtOnce(t *testing.T) {
	ctx, cli, env := exclusionsEnv(t)

	var list exclusionsResp
	require.NoError(t, cli.Get(ctx, "exclusions", nil, &list))
	require.NoError(t, cli.Post(ctx, "exclusions/reconcile", map[string]any{}, &struct{}{}))

	// a source rule goes to that source only
	var added addResp
	require.NoError(t, cli.Post(ctx, "exclusions", map[string]any{
		"addedBy": "compare",
		"rules":   []map[string]string{{"source": "/apps", "pattern": "Projects/**/build/"}},
	}, &added))
	require.Len(t, added.Added, 1)
	require.Empty(t, added.ApplyError)
	require.Len(t, added.Changes, 1)
	require.Equal(t, "/apps", added.Changes[0].Target)

	require.ElementsMatch(t, []string{".Trash/", "node_modules/", "Projects/**/build/"}, effective(ctx, t, env, "/apps"))
	require.ElementsMatch(t, []string{"/milo.db-wal", ".Trash/", "node_modules/"}, effective(ctx, t, env, "/home"))

	// the same rule again is not added twice
	require.NoError(t, cli.Post(ctx, "exclusions", map[string]any{
		"rules": []map[string]string{{"source": "/apps", "pattern": "Projects/**/build/"}},
	}, &added))
	require.Empty(t, added.Added)
	require.Len(t, added.Existing, 1)
	require.Empty(t, added.Changes)

	// a global rule reaches every source, in one request with another
	require.NoError(t, cli.Post(ctx, "exclusions", map[string]any{
		"rules": []map[string]string{{"pattern": "*.tmp"}, {"pattern": ".cache/"}},
	}, &added))
	require.Len(t, added.Added, 2)

	for _, p := range []string{"/apps", "/home"} {
		require.Subset(t, effective(ctx, t, env, p), []string{"*.tmp", ".cache/"}, p)
	}

	// removing it takes it out again, and the record of it stays
	var removed struct {
		Removed struct {
			Pattern string `json:"pattern"`
		} `json:"removed"`
	}

	require.NoError(t, cli.Delete(ctx, "exclusions/"+added.Added[0].ID, nil, nil, &removed))
	require.NotContains(t, effective(ctx, t, env, "/home"), removed.Removed.Pattern)

	require.NoError(t, cli.Get(ctx, "exclusions", nil, &list))
	require.Empty(t, list.Drift)
	require.Len(t, list.Removed, 1)

	require.Error(t, cli.Delete(ctx, "exclusions/nope", nil, nil, &removed))
}

func TestExclusionsRejectBadPatterns(t *testing.T) {
	ctx, cli, _ := exclusionsEnv(t)

	for _, bad := range []string{"", "# note", "!keep", "a\nb"} {
		err := cli.Post(ctx, "exclusions", map[string]any{"rules": []map[string]string{{"pattern": bad}}}, &addResp{})
		require.Error(t, err, bad)
	}

	require.Error(t, cli.Post(ctx, "exclusions", map[string]any{"rules": []map[string]string{}}, &addResp{}))
	require.Error(t, cli.Post(ctx, "exclusions", map[string]any{"addedBy": "robot", "rules": []map[string]string{{"pattern": "a"}}}, &addResp{}))

	// nothing was added by the failed requests
	var list exclusionsResp
	require.NoError(t, cli.Get(ctx, "exclusions", nil, &list))
	require.Len(t, list.Rules, 3)
}

func TestExclusionsNetRulesAndPreview(t *testing.T) {
	ctx, cli, _ := exclusionsEnv(t)

	var list exclusionsResp
	require.NoError(t, cli.Get(ctx, "exclusions", nil, &list))
	require.NoError(t, cli.Post(ctx, "exclusions/reconcile", map[string]any{}, &struct{}{}))

	var net struct {
		Rules []struct {
			Pattern string `json:"pattern"`
			From    string `json:"from"`
		} `json:"rules"`
		InSync bool `json:"inSync"`
	}

	require.NoError(t, cli.Get(ctx, "exclusions/net?source="+url.QueryEscape("/home"), nil, &net))
	require.True(t, net.InSync)

	from := map[string]string{}
	for _, r := range net.Rules {
		from[r.Pattern] = r.From
	}

	require.Equal(t, map[string]string{"/milo.db-wal": "source", ".Trash/": "global", "node_modules/": "global"}, from)

	var preview struct {
		Partial bool `json:"partial"`
		Results []struct {
			Pattern string `json:"pattern"`
			Error   string `json:"error"`
			Matches int    `json:"matches"`
			Files   int64  `json:"files"`
			Bytes   int64  `json:"bytes"`
			Top     []struct {
				Path string `json:"path"`
				Size int64  `json:"size"`
			} `json:"top"`
		} `json:"results"`
	}

	require.NoError(t, cli.Post(ctx, "exclusions/preview", map[string]any{
		"source":   "/home",
		"patterns": []string{"Projects/**/build/", "node_modules/", "/Library/Caches", "nothing-here/", "#bad"},
	}, &preview))
	require.False(t, preview.Partial)
	require.Len(t, preview.Results, 5)

	byPattern := map[string]int{}
	for i, r := range preview.Results {
		byPattern[r.Pattern] = i
	}

	build := preview.Results[byPattern["Projects/**/build/"]]
	require.Equal(t, 2, build.Matches, "Projects/a/build and Projects/build, not Library/build")
	require.Equal(t, int64(2), build.Files)
	require.Equal(t, int64(7), build.Bytes)
	require.Equal(t, "Projects/a/build", build.Top[0].Path)

	nm := preview.Results[byPattern["node_modules/"]]
	require.Equal(t, 2, nm.Matches, "the root one and Projects/a/node_modules")
	require.Equal(t, int64(9), nm.Bytes)

	require.Equal(t, 1, preview.Results[byPattern["/Library/Caches"]].Matches)
	require.Zero(t, preview.Results[byPattern["nothing-here/"]].Matches)
	require.NotEmpty(t, preview.Results[byPattern["#bad"]].Error)

	require.Error(t, cli.Post(ctx, "exclusions/preview", map[string]any{"source": "/none", "patterns": []string{"a"}}, &preview))
}
