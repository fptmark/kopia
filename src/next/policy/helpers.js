// Reading and changing a policy as plain data, by dotted path ("retention.keepLatest").
import { ownerName } from "../snapshots";

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

function isEmpty(v) {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
  );
}

/** A copy of obj with the value at path set; an empty value removes it, and objects left empty go with it. */
export function setPath(obj, path, value) {
  const [head, ...rest] = path.split(".");
  const copy = { ...(obj || {}) };

  const next = rest.length ? setPath(copy[head], rest.join("."), value) : value;
  if (isEmpty(next)) {
    delete copy[head];
  } else {
    copy[head] = next;
  }

  return copy;
}

/** "9:30" style times of day as a list of {hour, min}; a line that is not a time stays as text. */
export function parseTimeOfDay(line) {
  const m = /^\s*(\d+):(\d+)\s*$/.exec(line);
  if (m) {
    const hour = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (hour < 24 && min < 60 && m[2].length === 2) {
      return { hour, min };
    }
  }
  return line;
}

export function formatTimeOfDay(t) {
  return typeof t === "object" ? t.hour + ":" + String(t.min).padStart(2, "0") : String(t);
}

export function timesToText(times) {
  return (times || []).map(formatTimeOfDay).join("\n");
}

export function textToTimes(text) {
  return text === "" ? undefined : text.split("\n").map(parseTimeOfDay);
}

export function linesToText(lines) {
  return (lines || []).join("\n");
}

export function textToLines(text) {
  return text === "" ? undefined : text.split("\n");
}

const ACTIONS = ["beforeSnapshotRoot", "afterSnapshotRoot", "beforeFolder", "afterFolder"];
const LIST_PATHS = [
  "files.ignore",
  "files.ignoreDotFiles",
  "compression.onlyCompress",
  "compression.neverCompress",
  "scheduling.cron",
];

/**
 * The policy to save: lists without empty lines, times of day checked, actions without a script dropped
 * (and a timeout of 5 minutes where none is set). Throws an Error saying what is wrong.
 */
export function cleanPolicy(policy) {
  let p = JSON.parse(JSON.stringify(policy || {}));

  for (const path of LIST_PATHS) {
    const list = getPath(p, path);
    if (list) {
      p = setPath(
        p,
        path,
        list.map((s) => String(s).trim()).filter((s) => s !== ""),
      );
    }
  }

  const times = getPath(p, "scheduling.timeOfDay");
  if (times) {
    const kept = times.filter((t) => t !== "");
    for (const t of kept) {
      if (typeof t !== "object") {
        throw new Error("Invalid time of day: '" + t + "'. Use hours and minutes like 9:30 or 21:05.");
      }
    }
    p = setPath(p, "scheduling.timeOfDay", kept);
  }

  for (const a of ACTIONS) {
    const action = getPath(p, "actions." + a);
    if (action) {
      if (!action.script) {
        p = setPath(p, "actions." + a, undefined);
      } else if (action.timeout === undefined) {
        p = setPath(p, "actions." + a + ".timeout", 300);
      }
    }
  }

  return p;
}

/** Where a value comes from, in words: "this policy", "the global policy", or the policy it is defined on. */
export function definedBy(def, target) {
  if (!def) {
    return "";
  }
  if (
    def.userName === (target.userName ?? "") &&
    def.host === (target.host ?? "") &&
    def.path === (target.path ?? "")
  ) {
    return "this policy";
  }
  if (!def.userName && !def.host && !def.path) {
    return "the global policy";
  }
  if (!def.userName && !def.path) {
    return "host " + def.host;
  }
  if (!def.path) {
    return "user " + ownerName(def);
  }
  return def.path;
}
