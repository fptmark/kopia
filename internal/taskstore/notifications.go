package taskstore

import (
	"time"

	"github.com/pkg/errors"
)

// NotificationEntry is one attempt to deliver a notification.
type NotificationEntry struct {
	SentAt      time.Time `json:"sentAt"`
	Destination string    `json:"destination"`
	Event       string    `json:"event"`
	Mode        string    `json:"mode"`
	Status      string    `json:"status"`
	Attempts    int       `json:"attempts"`
	Error       string    `json:"error,omitempty"`
}

// RecordNotification keeps the outcome of delivering a notification.
func (s *Store) RecordNotification(e NotificationEntry) error {
	_, err := s.db.Exec(
		`INSERT INTO notification_log (sent_at, destination, event, mode, status, attempts, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		e.SentAt.UnixNano(), e.Destination, e.Event, e.Mode, e.Status, e.Attempts, e.Error)

	return errors.Wrap(err, "unable to record notification")
}

// Notifications returns the recorded notifications, newest first.
func (s *Store) Notifications(limit int) ([]NotificationEntry, error) {
	if limit <= 0 {
		limit = defaultListLimit
	}

	rows, err := s.db.Query(`SELECT sent_at, destination, event, mode, status, attempts, error FROM notification_log ORDER BY sent_at DESC, seq DESC LIMIT ?`, limit)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read notification log")
	}

	defer rows.Close() //nolint:errcheck

	out := []NotificationEntry{}

	for rows.Next() {
		var (
			e  NotificationEntry
			at int64
		)

		if err := rows.Scan(&at, &e.Destination, &e.Event, &e.Mode, &e.Status, &e.Attempts, &e.Error); err != nil {
			return nil, errors.Wrap(err, "unable to read notification log")
		}

		e.SentAt = time.Unix(0, at)
		out = append(out, e)
	}

	return out, errors.Wrap(rows.Err(), "unable to read notification log")
}
