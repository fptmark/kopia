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
	UserName string      `json:"userName"`
	Host     string      `json:"host"`
	Errors   []TaskError `json:"errors"`
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
	BytesStringBase2       bool   `json:"bytesStringBase2"`       // If `true`, display storage values in base-2 (default is base-10)
	DefaultSnapshotViewAll bool   `json:"defaultSnapshotViewAll"` // If `true` default to showing all snapshots (default is local snapshots)
	Theme                  string `json:"theme"`                  // Specifies the theme used by the UI
	FontSize               string `json:"fontSize"`               // Specifies the font size used by the UI
	PageSize               int    `json:"pageSize"`               // A page size; the actual possible values will only be provided by the frontend
	Language               string `json:"language"`               // Specifies the language used by the UI
	Locale                 string `json:"locale"`                 // Specifies the locale used by the UI for formatting numbers and dates
	KeepAwake              string `json:"keepAwake"`              // Prevent macOS sleep while snapshots run: "" or "never", "idle" (any power source), "ac" (only on AC power)
	VerifierIMessageTo     string `json:"verifierIMessageTo"`     // Phone number or Apple ID that receives an iMessage when the backup health check fails ("" sends none)
}

// VerifyCheck is the outcome of one backup health check.
type VerifyCheck struct {
	Name      string    `json:"name"`
	OK        bool      `json:"ok"`
	Detail    string    `json:"detail"`
	CheckedAt time.Time `json:"checkedAt"` // when this check last ran
}

// VerifyStatus is the current result of the backup health checks.
type VerifyStatus struct {
	Enabled        bool          `json:"enabled"`
	State          string        `json:"state"` // "unknown" until the first run, then "ok" or "failing"
	Since          time.Time     `json:"since"` // when the state last changed
	LastRun        *time.Time    `json:"lastRun,omitempty"`
	LastDeep       *time.Time    `json:"lastDeepRun,omitempty"`
	LastDeepTaskID string        `json:"lastDeepTaskId,omitempty"`
	Checks         []VerifyCheck `json:"checks"`
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
