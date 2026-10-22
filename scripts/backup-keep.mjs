// Which old backup files the nightly job may delete. Pure (no disk access) so it can be tested.
//
// Keeps: the newest `keepNewest` backups, plus the newest backup of each of the last
// `keepMonths` calendar months. Files that are not named samstore-YYYYMMDD-HHMM.dump are
// never listed, so nothing else in the folder can be deleted by mistake.

export const BACKUP_NAME = /^samstore-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.dump$/;

/** @param {string[]} names @param {{keepNewest?: number, keepMonths?: number}} [opts] @returns {string[]} names to delete */
export function pickToDelete(names, opts = {}) {
  const keepNewest = opts.keepNewest ?? 14;
  const keepMonths = opts.keepMonths ?? 6;
  const backups = names.filter((n) => BACKUP_NAME.test(n)).sort().reverse(); // newest first (the stamp sorts as time)
  const keep = new Set(backups.slice(0, keepNewest));
  const seenMonths = [];
  for (const n of backups) {
    const month = n.slice("samstore-".length, "samstore-".length + 6);
    if (seenMonths.includes(month)) continue; // not the newest of its month
    if (seenMonths.length >= keepMonths) break;
    seenMonths.push(month);
    keep.add(n);
  }
  return backups.filter((n) => !keep.has(n));
}

/** "2026-10-22 21:30" from the file name, or null. */
export function backupTime(name) {
  const m = BACKUP_NAME.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null;
}
