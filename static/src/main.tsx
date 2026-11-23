import { createRoot } from "react-dom/client";
import ScreenerClient from "../../app/ScreenerClient";
import { installNetworkPolicy } from "./api/net";
import { ConnectionAlert } from "./shell/ConnectionAlert";
import { installHashTabs } from "./shell/hash-tabs";

// The request policy must be in place before the first screen effect runs.
installNetworkPolicy();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <>
      <ScreenerClient />
      <ConnectionAlert />
    </>,
  );
  installHashTabs();
}
