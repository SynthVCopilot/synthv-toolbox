# v3 Public Error Catalog

Status: frozen categories; action-specific codes remain discoverable

Every public failure includes `outcome: "failed"`, `traceId`, `code`, `phase`,
`writeState`, and `undoRequired`. Normal errors are at most 4 KB and contain no
raw fingerprint, lyrics, phoneme text, complete note list, or curve array.

| Family and examples | Stage | Project write | Caller action |
|---|---|---:|---|
| `INVALID_ARGUMENT`, `CONTEXT_INCOMPATIBLE`, `CONTEXT_SCOPE_MISMATCH` | accepted/contextResolved | No | Correct schema or obtain a matching Context |
| `SYNTHV_SESSION_CHANGED`, `CONTEXT_NOT_FOUND`, `GUARD_TOKEN_NOT_FOUND` | contextResolved | No | Reread; never reuse the old Context |
| `PROJECT_UNAVAILABLE`, `TRACK_NOT_FOUND`, `GROUP_NOT_FOUND`, `SELECTION_UNAVAILABLE` | freshRead | No | Open or reselect the intended target |
| `STALE_NOTE`, `STALE_AUTOMATION`, `STALE_TRACK`, `STALE_GROUP`, `STALE_TIME_AXIS` | guarded | No | Deliberately reread; do not auto-retry |
| `SHARED_GROUP_WRITE`, `STALE_GROUP_REFERENCE_COUNT` | guarded | No | Choose explicit all-reference intent with fresh count or isolate |
| `UNSUPPORTED_HOST_CAPABILITY`, `PARAMETER_NOT_FOUND`, `VOCAL_MODE_NOT_FOUND` | preflighted | No | Use a supported operation or hand off to the UI |
| `QUERY_RESPONSE_BUDGET_EXCEEDED` | projected | No | Request a smaller page/range or narrower relevant `include`/`fields` projection |
| `PROTOCOL_MISMATCH`, `BUILD_MISMATCH`, `BUILD_COHERENCE_UNKNOWN` | accepted/freshRead | No | Reinstall/reload the complete v3 component set |
| `HOST_POSTCONDITION_FAILED` | verified | Possible | If `undoRequired`, perform exactly one SynthV Undo, then reread |
| `PROJECT_WRITE_EXECUTION_FAILED`, `HOST_WRITE_FAILED` | mutated | Possible | Follow `undoRequired`; never blind-retry |
| `INTERNAL_ERROR` | any | As reported | Use `traceId` and support diagnostics; follow Undo guidance |

`expected` and `actual` raw fingerprints are private diagnostics. Public stale
errors may report target kind, point/note count, changed-range summary, and
fixed-length digests only.

`QUERY_RESPONSE_BUDGET_EXCEEDED` reports only the action, strategy, measured
character count, budget, and narrowing guidance. It never echoes the rejected
Query payload.

## Transport family

| Code | Stage | Project write | `retry` | Caller action |
|---|---|---:|---|---|
| `BRIDGE_NOT_CONNECTED` | freshRead | No | `start_bridge` | No heartbeat, or a stale one; start or reconnect Synthesizer V Studio, then retry |
| `BRIDGE_TIMEOUT` (`claimed: false`) | as reported | No | `query_again` | The request was never claimed; reread, then retry |
| `BRIDGE_TIMEOUT` (`claimed: true`) | mutated | Yes (`wrote: true`) | `query_again` | SynthV claimed the request before timing out; the outcome is unknown, reread and compare before retrying |
| `BRIDGE_BUSY` | accepted | No | `retry_later` | Another client or request holds the single-writer lock; wait and retry |

`BRIDGE_NOT_CONNECTED` is raised before any lock or request file is created:
`FileIpcClient` checks the heartbeat first and fails fast. `claimed` on a
`BRIDGE_TIMEOUT` reports whether the request file still carried this
client's `requestId` when the deadline passed; once claimed, the Lua host may
have already started the mutation, so the public envelope reports
`wrote: true` and `phase: "mutated"` even though the request never received a
response.

## Retry values

`retry` is one of `correct_request`, `query_again`, `undo_once_then_query_again`
(precedence given to `undoRequired`), `retry_later` (`BRIDGE_BUSY`), or
`start_bridge` (`BRIDGE_NOT_CONNECTED`). External MCP clients written against
an earlier version of this bridge that only expected `correct_request` and
`query_again` must treat unrecognized `retry` values the same as
`query_again`.
