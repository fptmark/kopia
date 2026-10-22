package uitask

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"
)

// TaskQuery selects tasks from the task history. Zero values mean "no restriction".
type TaskQuery struct {
	Status string    // exact status, e.g. FAILED
	Kind   string    // exact kind, e.g. Snapshot
	Text   string    // case-insensitive text found in the description or the error
	From   time.Time // tasks started at or after this time
	To     time.Time // tasks started at or before this time

	// BeforeSeq returns only tasks older than the task with this sequence number (for paging).
	BeforeSeq int
	// Limit is the maximum number of tasks returned.
	Limit int
}

// HistoryStore keeps finished tasks permanently, so they survive a server restart and the in-memory limit.
type HistoryStore interface {
	// TaskStarted records that a task has started.
	TaskStarted(info Info) error
	// TaskFinished records the outcome of a task together with its log.
	TaskFinished(info Info, logLines []json.RawMessage) error
	// MaxTaskSeq returns the highest task sequence number recorded, so new tasks continue after it.
	MaxTaskSeq() (int, error)
	// ListTasks returns the matching tasks, newest first, and how many match in total.
	ListTasks(q TaskQuery) ([]Info, int, error)
	// GetTask returns one task.
	GetTask(seq int) (Info, bool, error)
	// TaskLogs returns the log of one finished task.
	TaskLogs(seq int) ([]json.RawMessage, error)
}

// SetHistory makes the manager record tasks in the given store and continue numbering after the tasks it holds.
func (m *Manager) SetHistory(h HistoryStore) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if h != nil {
		last, err := h.MaxTaskSeq()
		if err != nil {
			return err //nolint:wrapcheck
		}

		if last > m.nextTaskID {
			m.nextTaskID = last
		}
	}

	m.history = h

	return nil
}

// ParseTaskID converts a task ID as shown in the UI (hexadecimal) to its sequence number.
func ParseTaskID(id string) (int, bool) {
	n, err := strconv.ParseInt(id, 16, 32)
	if err != nil || n <= 0 {
		return 0, false
	}

	return int(n), true
}

// FormatTaskID is the inverse of ParseTaskID.
func FormatTaskID(seq int) string {
	return strconv.FormatInt(int64(seq), 16)
}

// QueryTasks returns running tasks (when they match) followed by finished tasks from the history,
// newest first, and the total number of matching tasks. Without a history store it works on the tasks
// held in memory.
func (m *Manager) QueryTasks(ctx context.Context, q TaskQuery) ([]Info, int, error) {
	_ = ctx

	m.mu.Lock()
	h := m.history
	m.mu.Unlock()

	if h == nil {
		all := m.ListTasks()
		out := make([]Info, 0, len(all))

		for _, t := range all {
			if q.matches(t) {
				out = append(out, t)
			}
		}

		return out, len(out), nil
	}

	m.mu.Lock()
	var running []Info

	runningIDs := map[int]bool{}

	for _, r := range m.running {
		runningIDs[r.sequenceNumber] = true

		if i := r.info(); q.matches(i) {
			running = append(running, i)
		}
	}
	m.mu.Unlock()

	sortNewestFirst(running)

	finishedQuery := q
	if q.Status == string(StatusRunning) || q.Status == string(StatusCanceling) {
		// only tasks that are running right now can have these statuses
		return running, len(running), nil
	}

	stored, total, err := h.ListTasks(finishedQuery)
	if err != nil {
		return nil, 0, err //nolint:wrapcheck
	}

	// a task that is running is also in the store; show it once, from memory
	filtered := stored[:0]

	for _, s := range stored {
		if seq, ok := ParseTaskID(s.TaskID); ok && runningIDs[seq] {
			total--

			continue
		}

		filtered = append(filtered, s)
	}

	if q.BeforeSeq > 0 {
		// later pages never repeat running tasks
		return filtered, total, nil
	}

	return append(running, filtered...), total + len(running), nil
}

func sortNewestFirst(infos []Info) {
	sort.Slice(infos, func(i, j int) bool { return infos[i].sequenceNumber > infos[j].sequenceNumber })
}

func (q TaskQuery) matches(i Info) bool {
	if q.Status != "" && string(i.Status) != q.Status {
		return false
	}

	if q.Kind != "" && i.Kind != q.Kind {
		return false
	}

	if !q.From.IsZero() && i.StartTime.Before(q.From) {
		return false
	}

	if !q.To.IsZero() && i.StartTime.After(q.To) {
		return false
	}

	if q.Text != "" && !containsFold(i.Description+"\n"+i.ErrorMessage, q.Text) {
		return false
	}

	return true
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}
