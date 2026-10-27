// locale to use for number formatting (undefined would use default locale, but we stick to EN for now)
const base10UnitPrefixes = ["", "K", "M", "G", "T"];
const base2UnitPrefixes = ["", "Ki", "Mi", "Gi", "Ti"];

function formatNumber(f) {
  return Math.round(f * 10) / 10.0 + "";
}

function toDecimalUnitString(f, thousand, prefixes, suffix) {
  for (var i = 0; i < prefixes.length; i++) {
    if (f < 0.9 * thousand) {
      return formatNumber(f) + " " + prefixes[i] + suffix;
    }
    f /= thousand;
  }

  return formatNumber(f) + " " + prefixes[prefixes.length - 1] + suffix;
}

export function sizeDisplayName(size, bytesStringBase2) {
  if (size === undefined) {
    return "";
  }
  if (bytesStringBase2) {
    return toDecimalUnitString(size, 1024, base2UnitPrefixes, "B");
  }
  return toDecimalUnitString(size, 1000, base10UnitPrefixes, "B");
}

/**
 * Shortens a count for display: 999, 1.3K, 12K, 1.3M, 2.1B.
 * @param {number} n
 * @returns {string}
 */
export function compactCount(n) {
  if (n === undefined || n === null || Number.isNaN(n)) {
    return "";
  }

  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];

  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (Math.abs(n) < size) {
      continue;
    }

    let v = Math.round((n / size) * 10) / 10;
    // 999,960 rounds to 1000K: show it as 1M instead
    if (Math.abs(v) >= 1000 && i > 0) {
      return compactCount(Math.sign(n) * units[i - 1][0]);
    }

    return v + suffix;
  }

  return String(Math.round(n));
}

export function objectLink(n) {
  if (n.startsWith("k") || n.startsWith("Ik")) {
    return "/snapshots/dir/" + n;
  }
  return "/api/v1/objects/" + n;
}

export function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

