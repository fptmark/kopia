// Package uitask provided management of in-process long-running tasks that are exposed to the UI.
package uitask

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/taskprogress"
	"github.com/kopia/kopia/repo/logging"
)

var log = logging.Module("uitask") //nolint:gochecknoglobals

const (
	maxFinishedTasks      = 50
	maxLogMessagesPerTask = 1000
	minWaitInterval       = 500 * time.Millisecond
	maxWaitInterval       = time.Second

	// defaultStallTimeout is used when Manager.StallTimeout is nil.
	defaultStallTimeout = 30 * time.Second
)

// stallCheckInterval is how often the stall watchdog polls a running task's Reporter. A var, not a const, so
// a test can shrink it instead of waiting on real time.
var stallCheckInterval = time.Second //nolint:gochecknoglobals

// Manager manages UI tasks.
type Manager struct {
	mu sync.Mutex
	// +checklocks:mu
	nextTaskID int
	// +checklocks:mu
	running map[string]*runningTaskInfo
	// +checklocks:mu
	finished map[string]*Info

	MaxFinishedTasks      int // +checklocksignore
	MaxLogMessagesPerTask int // +checklocksignore

	persistentLogs bool // +checklocksignore

	// +checklocks:mu
	history HistoryStore

	// StallTimeout, called fresh for each running task (so a preference change applies to the very next task
	// without a restart), returns how long a task may go with no single storage operation completing before
	// Run cancels it on its own, with a reason distinguishing this from a user Stop (see CancelTaskWithReason).
	// nil uses defaultStallTimeout. +checklocksignore
	StallTimeout func() time.Duration
}

func (m *Manager) stallTimeout() time.Duration {
	if m.StallTimeout == nil {
		return defaultStallTimeout
	}

	return m.StallTimeout()
}

// Controller allows the task to communicate with task manager and receive signals.
type Controller interface {
	CurrentTaskID() string
	OnCancel(cancelFunc context.CancelFunc)
	ReportCounters(counters map[string]CounterValue)
	ReportProgressInfo(text string)
}

// TaskFunc represents a task function.
type TaskFunc func(ctx context.Context, ctrl Controller) error

// Run executes the provided task in the current goroutine while allowing it to be externally examined and canceled.
func (m *Manager) Run(ctx context.Context, kind, description string, task TaskFunc) error {
	r := &runningTaskInfo{
		Info: Info{
			Kind:        kind,
			Description: description,
			Status:      StatusRunning,
		},
		maxLogMessages: m.MaxLogMessagesPerTask,
	}

	if m.persistentLogs {
		// log to regular file logger in addition to in-memory buffers.
		ctx = logging.WithAdditionalLogger(ctx, r.loggerForModule)
	} else {
		// only log to in-memory buffers.
		ctx = logging.WithLogger(ctx, r.loggerForModule)
	}

	m.startTask(r)

	reporter := taskprogress.New(r.ReportProgressInfo)
	ctx = taskprogress.WithReporter(ctx, reporter)

	stopWatchdog := m.watchForStall(r.TaskID, reporter)
	defer stopWatchdog()

	err := task(ctx, r)
	m.completeTask(r, err)

	return err
}

// watchForStall cancels taskID, with a clear CancelReason, the first time reporter goes stallTimeout()
// without a single storage operation completing -- which otherwise looks identical to "still running
// normally" to anyone watching the task (every retry/reconnect involved is Debug-level logging; see
// taskprogress's doc comment). Returns a function that must be called once the task finishes on its own, to
// stop the watchdog goroutine.
func (m *Manager) watchForStall(taskID string, reporter *taskprogress.Reporter) func() {
	done := make(chan struct{})

	go func() {
		ticker := time.NewTicker(stallCheckInterval)
		defer ticker.Stop()

		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				// clock.Now(), not the real wall-clock tick time, so a test can drive this with a fake clock.
				if stalled := reporter.StalledFor(clock.Now()); stalled >= m.stallTimeout() {
					m.CancelTaskWithReason(taskID, fmt.Sprintf("no response from storage for %v", stalled.Round(time.Second)))
					return
				}
			}
		}
	}()

	return func() { close(done) }
}

// ListTasks lists all running and some recently-finished tasks up to configured limits.
func (m *Manager) ListTasks() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()

	var res []Info

	for _, v := range m.running {
		res = append(res, v.info())
	}

	for _, v := range m.finished {
		res = append(res, *v)
	}

	// most recent first
	sort.Slice(res, func(i, j int) bool {
		return res[i].sequenceNumber > res[j].sequenceNumber
	})

	return res
}

// WaitForTask waits for the given task to finish running or until given amount of time elapses.
// If the task has not completed yet, (Info{}, false) is returned.
func (m *Manager) WaitForTask(ctx context.Context, taskID string, maxWaitTime time.Duration) (Info, bool) {
	if _, ok := m.GetTask(taskID); !ok {
		return Info{}, false
	}

	deadline := clock.Now().Add(maxWaitTime)

	sleepInterval := max(min(maxWaitTime/10, maxWaitInterval), minWaitInterval) //nolint:mnd

	for maxWaitTime < 0 || clock.Now().Before(deadline) {
		if !clock.SleepInterruptibly(ctx, sleepInterval) {
			return Info{}, false
		}

		i, ok := m.GetTask(taskID)
		if !ok {
			return Info{}, false
		}

		if i.Status.IsFinished() {
			return i, true
		}
	}

	return Info{}, false
}

// TaskSummary returns the summary (number of tasks by status).
func (m *Manager) TaskSummary() map[Status]int {
	m.mu.Lock()
	defer m.mu.Unlock()

	s := map[Status]int{
		StatusRunning: len(m.running),
	}

	for _, v := range m.finished {
		s[v.Status]++
	}

	return s
}

// TaskLog retrieves the log from the task.
func (m *Manager) TaskLog(taskID string) []json.RawMessage {
	m.mu.Lock()
	defer m.mu.Unlock()

	if r := m.running[taskID]; r != nil {
		return r.log()
	}

	if f, ok := m.finished[taskID]; ok {
		return append([]json.RawMessage(nil), f.LogLines...)
	}

	if m.history != nil {
		if seq, ok := ParseTaskID(taskID); ok {
			if lines, err := m.history.TaskLogs(seq); err == nil {
				return lines
			}
		}
	}

	return nil
}

// GetTask retrieves the task info.
func (m *Manager) GetTask(taskID string) (Info, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if r := m.running[taskID]; r != nil {
		return r.info(), true
	}

	if f, ok := m.finished[taskID]; ok {
		return *f, true
	}

	if m.history != nil {
		if seq, ok := ParseTaskID(taskID); ok {
			if t, found, err := m.history.GetTask(seq); err == nil && found {
				return t, true
			}
		}
	}

	return Info{}, false
}

// CancelTask cancels a running task, as if the user had clicked Stop.
func (m *Manager) CancelTask(taskID string) {
	m.cancelTask(taskID, "")
}

// CancelTaskWithReason cancels a running task on the server's own initiative rather than the user's -- reason
// is shown in the UI in place of the plain "Canceled" so it reads differently from a user-requested Stop.
func (m *Manager) CancelTaskWithReason(taskID, reason string) {
	m.cancelTask(taskID, reason)
}

func (m *Manager) cancelTask(taskID, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	t := m.running[taskID]
	if t == nil {
		return
	}

	t.cancel(reason)
}

func (m *Manager) startTask(r *runningTaskInfo) string {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.nextTaskID++

	taskID := fmt.Sprintf("%x", m.nextTaskID)
	r.StartTime = clock.Now()
	r.TaskID = taskID
	r.sequenceNumber = m.nextTaskID
	m.running[taskID] = r

	if m.history != nil {
		if err := m.history.TaskStarted(r.Info); err != nil {
			log(context.Background()).Errorf("unable to record start of task %v: %v", taskID, err)
		}
	}

	return taskID
}

func (m *Manager) completeTask(r *runningTaskInfo, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()

	if err != nil {
		r.ErrorMessage = err.Error()
	}

	r.Error = err

	if r.Status != StatusCanceling {
		if err != nil {
			r.Status = StatusFailed
		} else {
			r.Status = StatusSuccess
		}
	} else {
		r.Status = StatusCanceled
	}

	r.ProgressInfo = ""

	now := clock.Now()
	r.EndTime = &now

	delete(m.running, r.TaskID)
	m.finished[r.TaskID] = &r.Info

	if m.history != nil {
		if err := m.history.TaskFinished(r.Info, r.LogLines); err != nil {
			log(context.Background()).Errorf("unable to record end of task %v: %v", r.TaskID, err)
		}
	}

	// delete oldest finished tasks up to configured limit.
	for len(m.finished) > m.MaxFinishedTasks {
		var (
			oldestSequenceNumber int
			oldestID             string
		)

		for _, v := range m.finished {
			if oldestSequenceNumber == 0 || v.sequenceNumber < oldestSequenceNumber {
				oldestSequenceNumber = v.sequenceNumber
				oldestID = v.TaskID
			}
		}

		delete(m.finished, oldestID)
	}
}

// NewManager creates new UI Task Manager.
func NewManager(alsoLogToFile bool) *Manager {
	return &Manager{
		running:  map[string]*runningTaskInfo{},
		finished: map[string]*Info{},

		MaxLogMessagesPerTask: maxLogMessagesPerTask,
		MaxFinishedTasks:      maxFinishedTasks,
		persistentLogs:        alsoLogToFile,
	}
}
