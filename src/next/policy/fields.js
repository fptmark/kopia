// What the policy editor shows: sections of settings. A setting is { path, label, help, type, ... }.
//
// types: number, bool (yes / no / inherit), flag (plain on/off), select (options), lines (one per line),
// duration, times (times of day), text, readonly.

const LOG_OPTIONS = [
  { value: "", label: "inherit" },
  { value: 0, label: "0 - no output" },
  { value: 1, label: "1 - minimal details" },
  ...[2, 3, 4].map((n) => ({ value: n, label: String(n) })),
  { value: 5, label: "5 - normal details" },
  ...[6, 7, 8, 9].map((n) => ({ value: n, label: String(n) })),
  { value: 10, label: "10 - maximum details" },
];

const ACTION_MODES = [
  { value: "essential", label: "must succeed" },
  { value: "optional", label: "ignore failures" },
  { value: "async", label: "run asynchronously, ignore failures" },
];

function actionFields(prefix, name, help) {
  return [
    { path: `actions.${prefix}.script`, label: name, help, type: "text" },
    {
      path: `actions.${prefix}.timeout`,
      label: "Timeout",
      help: "Seconds before Kopia stops the command.",
      type: "number",
    },
    {
      path: `actions.${prefix}.mode`,
      label: "Command mode",
      help: "Must succeed (default), ignore failures, or run in the background.",
      type: "select",
      options: ACTION_MODES,
    },
  ];
}

export const SECTIONS = [
  {
    id: "retention",
    label: "Retention",
    sourceOnly: true,
    note: "How many snapshots are kept. A snapshot is kept if any rule below covers it.",
    fields: [
      { path: "retention.keepLatest", label: "Latest", help: "The most recent snapshots to keep.", type: "number" },
      { path: "retention.keepHourly", label: "Hourly", help: "The last snapshot of each hour.", type: "number" },
      { path: "retention.keepDaily", label: "Daily", help: "The last snapshot of each day.", type: "number" },
      { path: "retention.keepWeekly", label: "Weekly", help: "The last snapshot of each week.", type: "number" },
      {
        path: "retention.keepMonthly",
        label: "Monthly",
        help: "The last snapshot of each calendar month.",
        type: "number",
      },
      {
        path: "retention.keepAnnual",
        label: "Annual",
        help: "The last snapshot of each calendar year.",
        type: "number",
      },
      {
        path: "retention.ignoreIdenticalSnapshots",
        label: "Skip identical snapshots",
        help: "Do not save a snapshot when no file has changed.",
        type: "bool",
      },
    ],
  },
  {
    id: "scheduling",
    label: "Snapshot",
    group: "schedule",
    groupLabel: "Schedule",
    sourceOnly: true,
    note: "Applies in server mode only.",
    fields: [
      {
        path: "scheduling.intervalSeconds",
        altPath: "scheduling.timeOfDay",
        label: "When",
        help: "Pick one. Choosing an option clears the other.",
        type: "schedule",
      },
      {
        path: "scheduling.cron",
        label: "Cron expressions",
        help: "One per line, five fields: minute hour day month weekday. Runs in addition to the choice above.",
        type: "lines",
      },
      {
        path: "scheduling.runMissed",
        label: "Run missed snapshots on start",
        help: "Only matters for times of day.",
        type: "bool",
      },
      { path: "scheduling.manual", label: "Manual snapshots only", help: "Turns the schedule off.", type: "bool" },
    ],
  },
  {
    id: "verifyScheduling",
    label: "Verify",
    group: "schedule",
    sourceOnly: true,
    note: "A periodic read-back of this source's newest snapshot, independent of the snapshot schedule. Off until a time, interval or cron line is set.",
    fields: [
      {
        path: "verifyScheduling.percent",
        modePath: "verifyScheduling.mode",
        label: "Verify",
        help: "Percent of files to read back. 100 checks every file.",
        type: "verifyPercent",
      },
      {
        path: "verifyScheduling.scheduling.intervalSeconds",
        altPath: "verifyScheduling.scheduling.timeOfDay",
        label: "When",
        help: "Pick one. Choosing an option clears the other.",
        type: "schedule",
      },
      {
        path: "verifyScheduling.scheduling.cron",
        label: "Cron expressions",
        help: "One per line, five fields: minute hour day month weekday. Runs in addition to the choice above.",
        type: "lines",
      },
      {
        path: "verifyScheduling.scheduling.runMissed",
        label: "Run missed verifies on start",
        help: "Only matters for times of day.",
        type: "bool",
      },
      {
        path: "verifyScheduling.scheduling.manual",
        label: "No periodic verify",
        help: "Turns the schedule off even if a policy above sets one.",
        type: "bool",
      },
    ],
  },
  {
    id: "files",
    label: "Files",
    fields: [
      {
        path: "files.ignore",
        label: "Left out",
        help: "Patterns of what is not backed up. They are managed on the Exclusions page.",
        type: "readonly",
        link: "/exclusions",
      },
      {
        path: "files.noParentIgnore",
        label: "Ignore rules of parent folders",
        help: "Do not apply ignore rules from folders above this one.",
        type: "flag",
      },
      {
        path: "files.ignoreDotFiles",
        label: "Ignore rule files",
        help: "Files inside folders that hold more ignore rules (.kopiaignore). One per line.",
        type: "lines",
      },
      {
        path: "files.noParentDotFiles",
        label: "Rule files of parent folders",
        help: "Do not use ignore rule files of folders above this one.",
        type: "flag",
      },
      {
        path: "files.ignoreCacheDirs",
        label: "Skip cache folders",
        help: "Folders with a CACHEDIR.TAG and similar.",
        type: "bool",
      },
      { path: "files.maxFileSize", label: "Skip files larger than", help: "In bytes.", type: "number" },
      {
        path: "files.oneFileSystem",
        label: "Stay on one filesystem",
        help: "Do not cross into other mounted disks.",
        type: "bool",
      },
    ],
  },
  {
    id: "errors",
    label: "Errors",
    fields: [
      {
        path: "errorHandling.ignoreDirectoryErrors",
        label: "Ignore folder errors",
        help: "Treat a folder that cannot be read as non-fatal.",
        type: "bool",
      },
      {
        path: "errorHandling.ignoreFileErrors",
        label: "Ignore file errors",
        help: "Treat a file that cannot be read as non-fatal.",
        type: "bool",
      },
      {
        path: "errorHandling.ignoreUnknownTypes",
        label: "Ignore unknown entries",
        help: "Treat unsupported entries as non-fatal.",
        type: "bool",
      },
    ],
  },
  {
    id: "compression",
    label: "Compression",
    fields: [
      {
        path: "compression.compressorName",
        label: "Algorithm",
        help: "Used for files in this folder and below.",
        type: "select",
        options: "compression",
      },
      {
        path: "compression.minSize",
        label: "Smallest file",
        help: "Smaller files are not compressed (bytes).",
        type: "number",
      },
      {
        path: "compression.maxSize",
        label: "Largest file",
        help: "Larger files are not compressed (bytes).",
        type: "number",
      },
      {
        path: "compression.onlyCompress",
        label: "Only compress",
        help: "File extensions, one per line.",
        type: "lines",
      },
      {
        path: "compression.neverCompress",
        label: "Never compress",
        help: "File extensions, one per line.",
        type: "lines",
      },
    ],
  },
  {
    id: "upload",
    label: "Upload",
    sourceOnly: true,
    fields: [
      {
        path: "upload.maxParallelSnapshots",
        label: "Snapshots at once",
        help: "How many snapshots may upload at the same time.",
        type: "number",
      },
      {
        path: "upload.maxParallelFileReads",
        label: "Files read at once",
        help: "Defaults to the number of processors.",
        type: "number",
      },
    ],
  },
  {
    id: "actions",
    label: "Actions",
    note: "Commands Kopia runs around a snapshot or a folder.",
    fields: [
      ...actionFields("beforeSnapshotRoot", "Before snapshot", "Command to run before the snapshot."),
      ...actionFields("afterSnapshotRoot", "After snapshot", "Command to run after the snapshot."),
      ...actionFields("beforeFolder", "Before folder", "Command to run before each folder."),
      ...actionFields("afterFolder", "After folder", "Command to run after each folder."),
    ],
  },
  {
    id: "logging",
    label: "Logging",
    fields: [
      {
        path: "logging.directories.snapshotted",
        label: "Folder snapshotted",
        help: "How much to log when a folder is snapshotted.",
        type: "select",
        options: LOG_OPTIONS,
        numeric: true,
      },
      {
        path: "logging.directories.ignored",
        label: "Folder ignored",
        help: "How much to log when a folder is ignored.",
        type: "select",
        options: LOG_OPTIONS,
        numeric: true,
      },
      {
        path: "logging.entries.snapshotted",
        label: "File snapshotted",
        help: "How much to log when a file or link is snapshotted.",
        type: "select",
        options: LOG_OPTIONS,
        numeric: true,
      },
      {
        path: "logging.entries.ignored",
        label: "File ignored",
        help: "How much to log when a file or link is ignored.",
        type: "select",
        options: LOG_OPTIONS,
        numeric: true,
      },
      {
        path: "logging.entries.cacheHit",
        label: "Cache hit",
        help: "How much to log when a file is not uploaded because it is unchanged.",
        type: "select",
        options: LOG_OPTIONS,
        numeric: true,
      },
      {
        path: "logging.entries.cacheMiss",
        label: "Cache miss",
        help: "How much to log when a file has to be read.",
        type: "select",
        options: LOG_OPTIONS,
        numeric: true,
      },
    ],
  },
  {
    id: "advanced",
    label: "Advanced",
    fields: [
      {
        path: "noParent",
        label: "Ignore parent policies",
        help: "Parent policies do not affect this folder or the folders below it.",
        type: "flag",
      },
    ],
  },
];

/** Every setting of every section. */
export const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);

/**
 * The editor's top-level tabs. A section with no `group` is its own tab; sections that share a `group` become
 * one tab with its own sub-tabs, in SECTIONS order, labeled by the first of them to declare `groupLabel`.
 */
export const SECTION_GROUPS = SECTIONS.reduce((groups, s) => {
  const id = s.group ?? s.id;
  const existing = groups.find((g) => g.id === id);
  if (existing) {
    existing.sections.push(s.id);
    existing.sourceOnly = existing.sourceOnly || !!s.sourceOnly;
  } else {
    groups.push({ id, label: s.groupLabel ?? s.label, sections: [s.id], sourceOnly: !!s.sourceOnly });
  }
  return groups;
}, []);
