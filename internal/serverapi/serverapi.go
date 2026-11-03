// Package serverapi contains GO types corresponding to Kopia server API.
package serverapi

import (
	"encoding/json"
	"time"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/repo/format"
	"github.com/kopia/kopia/repo/manifest"
	"github.com/kopia/kopia/repo/object"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
	"github.com/kopia/kopia/snapshot/restore"
	"github.com/kopia/kopia/snapshot/upload"
)

// StatusResponse is the response of 'status' HTTP API command.
// StorageUsageResponse describes the total size of all blobs in repository storage.
type StorageUsageResponse struct {
	TotalBytes int64     `json:"totalBytes"`
	BlobCount  int64     `json:"blobCount"`
	ComputedAt time.Time `json:"computedAt"`
	ElapsedMS  int64     `json:"elapsedMs"`

	// Running is true while a calculation is in progress in the background; StartedAt is when it began.
	Running   bool      `json:"running,omitempty"`
	StartedAt time.Time `json:"startedAt,omitempty"`
	// Error is the failure of the most recent calculation, if it failed.
	Error string `json:"error,omitempty"`
}

type StatusResponse struct {
	Connected                  bool           `json:"connected"`
	ConfigFile                 string         `json:"configFile,omitempty"`
	FormatVersion              format.Version `json:"formatVersion,omitempty"`
	Hash                       string         `json:"hash,omitempty"`
	Encryption                 string         `json:"encryption,omitempty"`
	ECC                        string         `json:"ecc,omitempty"`
	ECCOverheadPercent         int            `json:"eccOverheadPercent,omitempty"`
	Splitter                   string         `json:"splitter,omitempty"`
	MaxPackSize                int            `json:"maxPackSize,omitempty"`
	Storage                    string         `json:"storage,omitempty"`
	APIServerURL               string         `json:"apiServerURL,omitempty"`
	SupportsContentCompression bool           `json:"supportsContentCompression"`

	repo.ClientOptions

	// non-empty while the repository is being initialized (opened, created or connected).
	InitRepoTaskID string `json:"initTaskID,omitempty"`
}

// SourcesResponse is the response of 'sources' HTTP API command.
type SourcesResponse struct {
	LocalUsername string `json:"localUsername"`
	LocalHost     string `json:"localHost"`

	// if set to true, current repository supports accessing data for other users.
	MultiUser bool `json:"multiUser"`

	Sources []*SourceStatus `json:"sources"`
}

// SourceStatus describes the status of a single source.
type SourceStatus struct {
	Source           snapshot.SourceInfo     `json:"source"`
	Status           string                  `json:"status"`
	SchedulingPolicy policy.SchedulingPolicy `json:"schedule"`
	LastSnapshot     *snapshot.Manifest      `json:"lastSnapshot,omitempty"`
	NextSnapshotTime *time.Time              `json:"nextSnapshotTime,omitempty"`
	UploadCounters   *upload.Counters        `json:"upload,omitempty"`
	CurrentTask      string                  `json:"currentTask,omitempty"`
	// Overdue is set when the newest snapshot is older than the source's schedule allows (the limit the backup
	// health check uses); paused sources are never overdue.
	Overdue bool `json:"overdue,omitempty"`
}

// PolicyListEntry describes single policy.
type PolicyListEntry struct {
	ID     string              `json:"id"`
	Target snapshot.SourceInfo `json:"target"`
	Policy *policy.Policy      `json:"policy"`
}

// PoliciesResponse is the response of 'policies' HTTP API command.
type PoliciesResponse struct {
	Policies []*PolicyListEntry `json:"policies"`
}

// Empty represents empty request/response.
type Empty struct{}

// APIErrorCode indicates machine-readable error code returned in API responses.
type APIErrorCode string

// Supported error codes.
const (
	ErrorInternal           APIErrorCode = "INTERNAL"
	ErrorAlreadyConnected   APIErrorCode = "ALREADY_CONNECTED"
	ErrorAlreadyInitialized APIErrorCode = "ALREADY_INITIALIZED"
	ErrorInvalidPassword    APIErrorCode = "INVALID_PASSWORD"
	ErrorInvalidToken       APIErrorCode = "INVALID_TOKEN"
	ErrorMalformedRequest   APIErrorCode = "MALFORMED_REQUEST"
	ErrorNotConnected       APIErrorCode = "NOT_CONNECTED"
	ErrorNotFound           APIErrorCode = "NOT_FOUND"
	ErrorNotInitialized     APIErrorCode = "NOT_INITIALIZED"
	ErrorPathNotFound       APIErrorCode = "PATH_NOT_FOUND"
	ErrorStorageConnection  APIErrorCode = "STORAGE_CONNECTION"
	ErrorAccessDenied       APIErrorCode = "ACCESS_DENIED"
)

// ErrorResponse represents error response.
type ErrorResponse struct {
	Code  APIErrorCode `json:"code"`
	Error string       `json:"error"`
}

// SourceActionResponse is a per-source response.
type SourceActionResponse struct {
	Success bool `json:"success"`
}

// MultipleSourceActionResponse contains per-source responses for all sources targeted by API command.
type MultipleSourceActionResponse struct {
	Sources map[string]SourceActionResponse `json:"sources"`
}

// CreateRepositoryRequest contains request to create a repository in a given storage.
type CreateRepositoryRequest struct {
	ConnectRepositoryRequest
	NewRepositoryOptions repo.NewRepositoryOptions `json:"options"`
}

// CheckRepositoryExistsRequest returns success if a repository exists in a given storage, ErrorNotInitialized if not.
type CheckRepositoryExistsRequest struct {
	Storage blob.ConnectionInfo `json:"storage"`
}

// ConnectRepositoryRequest contains request to connect to a repository.
type ConnectRepositoryRequest struct {
	Storage             blob.ConnectionInfo `json:"storage"`
	Password            string              `json:"password"`
	Token               string              `json:"token"` // when set, overrides Storage and Password
	APIServer           *repo.APIServerInfo `json:"apiServer"`
	ClientOptions       repo.ClientOptions  `json:"clientOptions"`
	SyncWaitTimeSeconds int                 `json:"syncWaitTime"` // if non-zero, force particular wait time, negative == forever
}

// AlgorithmInfo is an information about a single algorithm.
type AlgorithmInfo struct {
	ID         string `json:"id"`
	Deprecated bool   `json:"deprecated"`
}

// SupportedAlgorithmsResponse returns the list of supported algorithms for repository creation.
type SupportedAlgorithmsResponse struct {
	DefaultHashAlgorithm       string `json:"defaultHash"`
	DefaultEncryptionAlgorithm string `json:"defaultEncryption"`
	DefaultECCAlgorithm        string `json:"defaultEcc"`
	DefaultSplitterAlgorithm   string `json:"defaultSplitter"`

	SupportedHashAlgorithms        []AlgorithmInfo `json:"hash"`
	SupportedEncryptionAlgorithms  []AlgorithmInfo `json:"encryption"`
	SupportedECCAlgorithms         []AlgorithmInfo `json:"ecc"`
	SupportedSplitterAlgorithms    []AlgorithmInfo `json:"splitter"`
	SupportedCompressionAlgorithms []AlgorithmInfo `json:"compression"`
}

// CreateSnapshotSourceRequest contains request to create snapshot source and optionally create first snapshot.
type CreateSnapshotSourceRequest struct {
	Path           string         `json:"path"`
	CreateSnapshot bool           `json:"createSnapshot"`
	Policy         *policy.Policy `json:"policy"` // policy to set on the path
}

// CreateSnapshotSourceResponse contains response of creating snapshot source.
type CreateSnapshotSourceResponse struct {
	SnapshotStarted bool `json:"snapshotted"` // whether snapshotting has been started
}

// Snapshot describes single snapshot entry.
type Snapshot struct {
	ID               manifest.ID          `json:"id"`
	Description      string               `json:"description"`
	StartTime        fs.UTCTimestamp      `json:"startTime"`
	EndTime          fs.UTCTimestamp      `json:"endTime"`
	IncompleteReason string               `json:"incomplete,omitempty"`
	Summary          *fs.DirectorySummary `json:"summary"`
	RootEntry        string               `json:"rootID"`
	RetentionReasons []string             `json:"retention"`
	Pins             []string             `json:"pins"`
}

// SnapshotsResponse contains a list of snapshots.
type SnapshotsResponse struct {
	Snapshots       []*Snapshot `json:"snapshots"`
	UnfilteredCount int         `json:"unfilteredCount"`
	UniqueCount     int         `json:"uniqueCount"`
}

// SnapshotStorageStat describes how much data one snapshot added to the repository.
type SnapshotStorageStat struct {
	ID manifest.ID `json:"id"`
	// bytes stored (compressed) for content first seen in this snapshot; depends on snapshot order.
	NewBytes int64 `json:"newBytes"`
	// bytes before compression for the same content.
	NewOriginalBytes int64 `json:"newOriginalBytes"`
	NewFiles         int32 `json:"newFiles"`
	NewDirs          int32 `json:"newDirs"`
}

// SnapshotStorageStatsResponse contains the storage cost of each snapshot of one source.
type SnapshotStorageStatsResponse struct {
	Snapshots []*SnapshotStorageStat `json:"snapshots"`
}

// SnapshotDiffEntry is one difference between two snapshots. A directory that exists in only one
// of them is a single entry that carries its totals.
type SnapshotDiffEntry struct {
	Path    string `json:"path"`
	Change  string `json:"change"` // added, removed or modified
	IsDir   bool   `json:"isDir"`
	OldSize int64  `json:"oldSize"`
	NewSize int64  `json:"newSize"`
	// files under an added or removed directory
	Files int64 `json:"files,omitempty"`
}

// SnapshotDiffResponse lists what changed between two snapshots of one source.
type SnapshotDiffResponse struct {
	Source    snapshot.SourceInfo  `json:"source"`
	From      *Snapshot            `json:"from"`
	To        *Snapshot            `json:"to"`
	Entries   []*SnapshotDiffEntry `json:"entries"`
	Truncated bool                 `json:"truncated"`
	// totals count every changed file, also when the list is truncated
	Added        int64 `json:"added"`
	Removed      int64 `json:"removed"`
	Modified     int64 `json:"modified"`
	AddedBytes   int64 `json:"addedBytes"`
	RemovedBytes int64 `json:"removedBytes"`
	// sum of (new size - old size) over modified files
	ModifiedDeltaBytes int64 `json:"modifiedDeltaBytes"`
}

// DeleteSnapshotsRequest contains request to delete a number of snapshots and optionally the
// entire snapshot source.
type DeleteSnapshotsRequest struct {
	SourceInfo            snapshot.SourceInfo `json:"source"`
	SnapshotManifestIDs   []manifest.ID       `json:"snapshotManifestIds"`
	DeleteSourceAndPolicy bool                `json:"deleteSourceAndPolicy"`
}

// EditSnapshotsRequest contains request to edit one or more snapshots.
type EditSnapshotsRequest struct {
	Snapshots      []manifest.ID `json:"snapshots"`
	NewDescription *string       `json:"description"`
	AddPins        []string      `json:"addPins"`
	RemovePins     []string      `json:"removePins"`
}

// MountSnapshotRequest contains request to mount a snapshot.
type MountSnapshotRequest struct {
	Root string `json:"root"`
}

// UnmountSnapshotRequest contains request to unmount a snapshot.
type UnmountSnapshotRequest struct {
	Root string `json:"root"`
}

// MountedSnapshot describes single mounted snapshot.
type MountedSnapshot struct {
	Path string    `json:"path"`
	Root object.ID `json:"root"`
}

// MountedSnapshots describes single mounted snapshot.
type MountedSnapshots struct {
	Items []*MountedSnapshot `json:"items"`
}

// CurrentUserResponse is the response of 'current-user' HTTP API command.
type CurrentUserResponse struct {
	Username string `json:"username"`
	Hostname string `json:"hostname"`
}

// TaskListResponse contains a list of tasks.
type TaskListResponse struct {
	Tasks []uitask.Info `json:"tasks"`
	// Total is how many tasks match the query, which can be more than were returned.
	Total int `json:"total"`
	// History is true when tasks are kept permanently (otherwise only recent ones are available).
	History bool `json:"history"`
	// Kinds lists the kinds of tasks that can be filtered on.
	Kinds []string `json:"kinds,omitempty"`
}

// TaskErrorsResponse lists the files that failed in a snapshot task.
type TaskErrorsResponse struct {
	// Source is the folder of the snapshot source; the paths of the errors are relative to it.
	Source string `json:"source"`
	// UserName and Host complete the source, to find its policy.
	UserName string `json:"userName"`
	Host     string `json:"host"`
	// SnapshotID is the snapshot the task made, empty when it made none.
	SnapshotID string      `json:"snapshotId,omitempty"`
	Errors     []TaskError `json:"errors"`
}

// SnapshotTaskResponse names the snapshot task that made a snapshot; TaskID is empty when none is on record.
type SnapshotTaskResponse struct {
	TaskID string `json:"taskId"`
}

// TaskError is a file or directory that could not be backed up.
type TaskError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
	// Kind is the cause (permission, missing, busy or other) and Ignored says an ignore rule hides the error.
	Kind    string `json:"kind"`
	Ignored bool   `json:"ignored,omitempty"`
}

// TaskLogResponse contains a task log.
type TaskLogResponse struct {
	Logs []json.RawMessage `json:"logs"` // formatted as uitask.LogEntry
}

// RestoreRequest contains request to restore an object (file or directory) to a given destination.
type RestoreRequest struct {
	Root string `json:"root"`

	Filesystem *restore.FilesystemOutput `json:"fsOutput"`

	ZipFile         string `json:"zipFile"`
	UncompressedZip bool   `json:"uncompressedZip"`

	TarFile string          `json:"tarFile"`
	Options restore.Options `json:"options"`
}

// EstimateRequest contains request to estimate the size of the snapshot in a given root.
type EstimateRequest struct {
	Root                 string         `json:"root"`
	MaxExamplesPerBucket int            `json:"maxExamplesPerBucket"`
	PolicyOverride       *policy.Policy `json:"policyOverride"`
}

// ResolvePolicyRequest contains request structure to ResolvePolicy.
type ResolvePolicyRequest struct {
	Updates                  *policy.Policy `json:"updates"`
	NumUpcomingSnapshotTimes int            `json:"numUpcomingSnapshotTimes"` // if > 0, return N UpcomingSnapshotTimes
}

// ResolvePolicyResponse returns the resolved details about a single policy.
type ResolvePolicyResponse struct {
	Effective             *policy.Policy     `json:"effective"`
	Definition            *policy.Definition `json:"definition"`
	Defined               *policy.Policy     `json:"defined"`
	UpcomingSnapshotTimes []time.Time        `json:"upcomingSnapshotTimes"`
	SchedulingError       string             `json:"schedulingError,omitempty"`
	UpcomingVerifyTimes   []time.Time        `json:"upcomingVerifyTimes"`
	VerifySchedulingError string             `json:"verifySchedulingError,omitempty"`
}

// UpcomingTask is one scheduled snapshot or verify that has not run yet.
type UpcomingTask struct {
	Time   time.Time           `json:"time"`
	Kind   string              `json:"kind"` // Snapshot or Verify
	Source snapshot.SourceInfo `json:"source"`
}

// UpcomingTasksResponse lists the next scheduled tasks across every source, soonest first.
type UpcomingTasksResponse struct {
	Tasks []UpcomingTask `json:"tasks"`
}

// ResolvePathRequest contains request to resolve a particular path to ResolvePathResponse.
type ResolvePathRequest struct {
	Path string `json:"path"`
}

// ResolvePathResponse contains response to resolve a particular path.
type ResolvePathResponse struct {
	SourceInfo snapshot.SourceInfo `json:"source"`
}

// CLIInfo contains CLI information.
type CLIInfo struct {
	Executable string `json:"executable"`
}

// UIPreferences represents JSON object storing UI preferences.
type UIPreferences struct {
	BytesStringBase2       bool    `json:"bytesStringBase2"`       // If `true`, display storage values in base-2 (default is base-10)
	DefaultSnapshotViewAll bool    `json:"defaultSnapshotViewAll"` // If `true` default to showing all snapshots (default is local snapshots)
	Theme                  string  `json:"theme"`                  // Specifies the theme used by the UI
	FontSize               string  `json:"fontSize"`               // Specifies the font size used by the UI
	PageSize               int     `json:"pageSize"`               // A page size; the actual possible values will only be provided by the frontend
	Language               string  `json:"language"`               // Specifies the language used by the UI
	Locale                 string  `json:"locale"`                 // Specifies the locale used by the UI for formatting numbers and dates
	KeepAwake              string  `json:"keepAwake"`              // Prevent macOS sleep while snapshots run: "" or "never", "idle" (any power source), "ac" (only on AC power)
	VerifierIMessageTo     string  `json:"verifierIMessageTo"`     // Phone number or Apple ID that receives an iMessage when the backup health check fails ("" sends none)
	VerifyNewData          bool    `json:"verifyNewData"`          // If `true`, verify each snapshot right after it finishes
	DateFormat             string  `json:"dateFormat"`             // How summary pages write dates: "medium" (Oct 26, 2026, 7:00 AM), "numeric" (10/26/2026, 7:00 AM) or "iso" (2026-10-26 07:00)
	VerifyEachMode         string  `json:"verifyEachMode"`         // What to verify: "new" (the data the snapshot added, the default), "sample" or "full"
	VerifyEachPercent      float64 `json:"verifyEachPercent"`      // The share of files to read back when VerifyEachMode is "sample"
	// StorageStallTimeoutSeconds quits a Snapshot/Verify/Maintenance task if a single storage operation
	// (listing, reading, writing) goes this long with no response -- a dead/unreachable NAS otherwise just
	// looks like a task that is still quietly running. 0 (unset) uses the default, 30s.
	StorageStallTimeoutSeconds int `json:"storageStallTimeoutSeconds"`
	// WakeGraceSeconds is how long, after the server detects a gap consistent with the machine having just
	// woken from sleep, it defers starting new Snapshot/Verify/Maintenance work and holds off reporting
	// snapshots as stale -- the connection is often still settling right after a real wake. 0 (unset) uses
	// the default, 5 minutes.
	WakeGraceSeconds int `json:"wakeGraceSeconds"`
}

// VerifyFailure is a file that did not read back.
type VerifyFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// VerifyCheck is the outcome of one backup health check.
type VerifyCheck struct {
	Name      string    `json:"name"`
	OK        bool      `json:"ok"`
	Detail    string    `json:"detail"`
	CheckedAt time.Time `json:"checkedAt"` // when this check last ran
	// FailureCount is how many files failed; Failures lists the first of them, and VerificationID names
	// the stored record with all of them (GET /api/v1/snapshots/verifications/{id}/failures).
	FailureCount   int             `json:"failureCount,omitempty"`
	Failures       []VerifyFailure `json:"failures,omitempty"`
	VerificationID int64           `json:"verificationId,omitempty"`
}

// FailingSnapshot is one snapshot whose latest verification (of one mode) currently fails: one row in the
// health banner, with its own Verify and Details.
type FailingSnapshot struct {
	// ID is the verification's own id (not the snapshot's): pass it to POST /api/v1/verify/failing/dismiss.
	ID         int64     `json:"id"`
	SnapshotID string    `json:"snapshotId"`
	Source     string    `json:"source"`
	Mode       string    `json:"mode"` // "new", "sample" or "full" -- what Verify should re-run
	Percent    float64   `json:"percent"`
	FinishedAt time.Time `json:"finishedAt"`
	Files      int64     `json:"files"`
	ReadBytes  int64     `json:"readBytes"`
	ErrorCount int64     `json:"errorCount"`
	TaskID     string    `json:"taskId,omitempty"`
	Badge      string    `json:"badge"`  // short label for the row, e.g. "7 failed" or "New data"
	Detail     string    `json:"detail"` // the full reason, for a tooltip
}

// VerifyStatus is the current result of the backup health checks.
type VerifyStatus struct {
	Enabled        bool          `json:"enabled"`
	State          string        `json:"state"` // "unknown" until the first run, then "ok" or "failing"
	Since          time.Time     `json:"since"` // when the state last changed
	LastRun        *time.Time    `json:"lastRun,omitempty"`
	LastDeep       *time.Time    `json:"lastDeepRun,omitempty"`
	LastDeepTaskID string        `json:"lastDeepTaskId,omitempty"`
	DeepRunning    bool          `json:"deepRunning"` // the full check (Run full check now, or the daily one) is running right now
	Checks         []VerifyCheck `json:"checks"`
	// FailingSnapshots are the snapshots backing the failure, one row per broken (source, mode); empty when
	// the failure (if any) comes only from a check with no single snapshot to verify, such as freshness.
	FailingSnapshots []FailingSnapshot `json:"failingSnapshots"`
	// ClearedTaskIDs are recent Verify tasks whose result found a previous failure of the same source and
	// mode passing again, so the Tasks list can mark them as having resolved a problem.
	ClearedTaskIDs []string `json:"clearedTaskIds"`
}

// SearchRequest describes a search for files and directories across snapshots.
type SearchRequest struct {
	// Pattern is a wildcard (* and ?) matched case-insensitively against the entry name, or against
	// the path relative to the snapshot source when it contains a slash.
	Pattern string `json:"pattern"`
	// From and To restrict the search to snapshots started in this range (zero means unbounded).
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
	// SourcePath optionally restricts the search to snapshots of one source path.
	SourcePath  string `json:"sourcePath,omitempty"`
	IncludeDirs bool   `json:"includeDirs,omitempty"`
	MaxResults  int    `json:"maxResults,omitempty"`
}

// SearchStartResponse is returned when a search is started.
type SearchStartResponse struct {
	ID string `json:"id"`
}

// SearchProgress reports how far a search has got.
type SearchProgress struct {
	SnapshotsTotal int   `json:"snapshotsTotal"`
	SnapshotsDone  int   `json:"snapshotsDone"`
	Directories    int64 `json:"directories"`
	Entries        int64 `json:"entries"`
}

// SearchResult is one version of a matching file or directory: identical content at the same path,
// together with the first and last snapshot (within the searched range) that contained it.
type SearchResult struct {
	Source        string    `json:"source"`
	Path          string    `json:"path"`
	Name          string    `json:"name"`
	IsDir         bool      `json:"isDir"`
	Size          int64     `json:"size"`
	ModTime       time.Time `json:"modTime"`
	ObjectID      string    `json:"objectId"`
	FirstSeen     time.Time `json:"firstSeen"`
	LastSeen      time.Time `json:"lastSeen"`
	SnapshotCount int       `json:"snapshotCount"`
}

// SearchStatus is the state of a search and the results found so far.
type SearchStatus struct {
	ID        string         `json:"id"`
	Running   bool           `json:"running"`
	Canceled  bool           `json:"canceled,omitempty"`
	Error     string         `json:"error,omitempty"`
	Truncated bool           `json:"truncated,omitempty"`
	StartedAt time.Time      `json:"startedAt"`
	Progress  SearchProgress `json:"progress"`
	Results   []SearchResult `json:"results"`
}

// SearchSourceRange describes the snapshots that exist for one source.
type SearchSourceRange struct {
	Source string    `json:"source"`
	Path   string    `json:"path"`
	Count  int       `json:"count"`
	First  time.Time `json:"first"`
	Last   time.Time `json:"last"`
}

// SearchRangeResponse describes the time span covered by all snapshots, so a search only offers valid dates.
type SearchRangeResponse struct {
	Count   int                 `json:"count"`
	First   time.Time           `json:"first"`
	Last    time.Time           `json:"last"`
	Sources []SearchSourceRange `json:"sources"`
}
