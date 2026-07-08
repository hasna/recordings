// Public `@hasna/recordings/storage` surface.
//
// The storage layer is a single `Store` interface with two transports:
// LocalStore (on-box SQLite) and ApiStore (self-hosted / cloud HTTP `/v1` +
// bearer key). There is NO client-side database DSN and NO local↔Postgres sync
// path — the shared cloud dataset is reached only through the authenticated API.

export { getStore, __resetStore, APP } from "./store.js";
export type { Store, RecordingStats, FeedbackInput } from "./store.js";

export {
  resolveStorageClient,
  resolveTransport,
  createHttpTransport,
  createStorageClient,
  toV1BaseUrl,
  defaultCloudBaseUrl,
  HasnaHttpError,
} from "./http/client.js";
export type {
  StorageClient,
  StorageMode,
  TransportKind,
  TransportResolution,
  HttpTransport,
} from "./http/client.js";
