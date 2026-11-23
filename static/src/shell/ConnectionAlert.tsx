import { useSyncExternalStore } from "react";
import { isConnectionAlertVisible, subscribeConnectionAlert } from "../api/connection";

/**
 * One clear message for a blocked data connection, with a retry action.
 * Repeated transport failures raise it; any successful response clears it.
 */
export function ConnectionAlert() {
  const visible = useSyncExternalStore(
    subscribeConnectionAlert,
    isConnectionAlertVisible,
    () => false,
  );
  if (!visible) return null;
  return (
    <div className="connection-alert" role="alert">
      <p>اتصال به داده بورس برقرار نشد. اگر VPN روشن است خاموشش کنید.</p>
      <button type="button" className="primary-button" onClick={() => window.location.reload()}>
        تلاش دوباره
      </button>
    </div>
  );
}
