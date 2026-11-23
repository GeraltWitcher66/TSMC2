/**
 * Tracks repeated transport failures so the shell can show one clear Persian
 * message with a retry action instead of leaving the user with an empty table.
 */

type Listener = () => void;

const FAILURE_WINDOW_MS = 20_000;
const FAILURES_BEFORE_MESSAGE = 2;

let failures = 0;
let lastFailureAt = 0;
let visible = false;
const listeners = new Set<Listener>();

function publish(next: boolean) {
  if (visible === next) return;
  visible = next;
  listeners.forEach((listener) => listener());
}

export function reportNetworkFailure() {
  const now = Date.now();
  if (now - lastFailureAt > FAILURE_WINDOW_MS) failures = 0;
  failures += 1;
  lastFailureAt = now;
  if (failures >= FAILURES_BEFORE_MESSAGE) publish(true);
}

export function reportNetworkSuccess() {
  failures = 0;
  publish(false);
}

export function isConnectionAlertVisible() {
  return visible;
}

export function subscribeConnectionAlert(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
