/**
 * Failed files of a snapshot, grouped for the dialog that lists them. Errors that share a cause and a part of
 * the tree become one line ("operation not permitted on Library/Accounts (12)").
 */

/**
 * Returns the most specific cause of an error. Kopia wraps errors into a chain like
 * "cannot create iterator: unable to read directory: open /a/b/c: permission denied".
 * The segments that contain a path are dropped (they would make every error unique) and the
 * innermost remaining one is kept ("permission denied"). If only generic wrappers remain,
 * the innermost wrapper is used ("unable to read directory").
 */
// A segment contains a path if some word in it starts with "/" ("open /a/b"). A slash inside a word,
// as in "input/output error", is part of a normal error reason.
function looksLikePath(segment) {
  return /(^|\s)\//.test(segment);
}

export function errorReason(message) {
  const segments = (message || "")
    .split(": ")
    .map((x) => x.trim())
    .filter((x) => x && !looksLikePath(x));

  return segments.length > 0 ? segments[segments.length - 1] : message || "unknown error";
}

function commonPrefix(lists) {
  let prefix = lists[0];
  for (const l of lists.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < l.length && prefix[i] === l[i]) {
      i++;
    }
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * Groups failures that have the same cause and live in the same part of the tree
 * (same first `depth` directories), e.g. "operation not permitted on Library/Accounts (12)".
 * Larger groups come first.
 */
export function groupFailures(errors, depth = 3) {
  const buckets = new Map();

  for (const e of errors) {
    const dirs = e.path.split("/").filter(Boolean).slice(0, -1);
    const reason = errorReason(e.error);
    const key = reason + "\u0000" + dirs.slice(0, depth).join("/");
    if (!buckets.has(key)) {
      buckets.set(key, { reason, items: [] });
    }
    buckets.get(key).items.push({ ...e, dirs });
  }

  const groups = [...buckets.values()].map(({ reason, items }) => {
    const dir = commonPrefix(items.map((i) => i.dirs)).join("/");
    return {
      reason,
      count: items.length,
      label: items.length === 1 ? items[0].path : dir || "(top level)",
      // the place an action on the whole group applies to ("" is the whole source)
      place: items.length === 1 ? items[0].path : dir,
      kind: items[0].kind,
      items: items.map(({ path, error, kind }) => ({ path, error, kind })).sort((a, b) => a.path.localeCompare(b.path)),
    };
  });

  return groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
