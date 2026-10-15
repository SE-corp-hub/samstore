// Interactive-transaction options for the Rice Ops steps.
//
// A signed step (sale, release, count…) runs many small queries in one transaction.
// Next to the database (the hosted API) that takes well under a second; from a PC far
// from the database (the operator's verify run against Supabase in Sydney) one query
// can take a few hundred milliseconds, and a long step can pass Prisma's limit. The
// limit stays as written in each service; TX_TIMEOUT_MS can only RAISE it (verify sets
// it for its slow link). Production leaves it unset.

export function txOptions(timeoutMs = 30_000): { timeout: number; maxWait: number } {
  const floor = Number(process.env.TX_TIMEOUT_MS);
  const timeout = Number.isFinite(floor) && floor > timeoutMs ? Math.min(floor, 300_000) : timeoutMs;
  return { timeout, maxWait: Math.max(10_000, Math.round(timeout / 3)) };
}
