// A queued step that the server could not answer properly must stay on the phone.
// Only a clear refusal of the step itself (wrong number, not allowed, already done) is final.
//
//   401  the login expired or was cut off: keep the step, the person signs in again, it is sent then
//   408 / 425 / 429 / 5xx  the server or its database was busy or down: keep it and try again later
//   any other 4xx  the server read the step and said no: that is an answer, list it under "Not sent"

/** After this many tries on a server error, stop blocking the steps behind it and list it as not sent. */
export const MAX_SERVER_TRIES = 200;

export function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Whether a failed attempt should stay in the queue (true) or be reported as not sent (false). */
export function keepInQueue(status: number, attemptsSoFar: number): boolean {
  if (!isRetryableStatus(status)) return false;
  if (status === 401) return true; // never drop a sale because the login ran out
  return attemptsSoFar + 1 < MAX_SERVER_TRIES;
}
