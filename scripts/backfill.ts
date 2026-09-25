import { initializeStore } from "../server/btc/store";
import { reconcile } from "../server/btc/service";

// Bounded, resumable pass over IDs observed by this app. There is no supported
// historical round enumeration in the official SDK. Re-run to check later IDs.
await initializeStore();
await reconcile();
console.log("Checked up to four known, expired market IDs. Unknown prior history remains unknown.");