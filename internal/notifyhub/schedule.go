package notifyhub

import "time"

// LatestDue returns the most recent moment, at or before now, that a summary with this schedule was due.
// It is the zero time for a schedule that is not periodic.
func LatestDue(s Success, now time.Time) time.Time {
	if !s.Scheduled() {
		return time.Time{}
	}

	t, err := time.Parse("15:04", s.Time)
	if err != nil {
		return time.Time{}
	}

	h, m := t.Hour(), t.Minute()
	loc := now.Location()
	at := func(y int, mo time.Month, d int) time.Time { return time.Date(y, mo, d, h, m, 0, 0, loc) }

	y, mo, d := now.Date()

	switch s.Freq {
	case FreqDaily:
		due := at(y, mo, d)
		if due.After(now) {
			due = at(y, mo, d-1)
		}

		return due
	case FreqWeekly:
		want := time.Weekday((s.Weekday + 1) % 7) // 0 is Monday; Go counts from Sunday
		back := (int(now.Weekday()) - int(want) + 7) % 7
		due := at(y, mo, d-back)

		if due.After(now) {
			due = at(y, mo, d-back-7)
		}

		return due
	}

	due := dayOfMonth(s.DOM, y, mo, h, m, loc)
	if due.After(now) {
		due = dayOfMonth(s.DOM, y, mo-1, h, m, loc)
	}

	return due
}

// dayOfMonth is day dom of the month at h:m, or the last day when dom is 0 (and for short months).
func dayOfMonth(dom, y int, mo time.Month, h, m int, loc *time.Location) time.Time {
	last := time.Date(y, mo+1, 0, h, m, 0, 0, loc) // day 0 of the next month
	if dom == 0 || dom > last.Day() {
		return last
	}

	return time.Date(y, mo, dom, h, m, 0, 0, loc)
}
