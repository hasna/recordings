// Public `@hasna/recordings/storage` surface.
//
// The storage layer is a single `Store` interface with two transports:
// LocalStore (on-box SQLite) and ApiStore (the server's HTTP `/v1` API + bearer
// key). There is NO client-side database DSN and NO client-side PostgresStore —
// the shared dataset is reached only through the authenticated API.

export { getStore, __resetStore, APP } from "./store.js";
export type { Store, RecordingStats, FeedbackInput } from "./store.js";

export {
  resolveStorageClient,
  resolveTransport,
  createHttpTransport,
  createStorageClient,
  toV1BaseUrl,
  defaultApiBaseUrl,
  HasnaHttpError,
} from "./http/client.js";
export type {
  StorageClient,
  ClientStore,
  TransportKind,
  TransportResolution,
  HttpTransport,
} from "./http/client.js";
