# Browser bridge protocol v1

Transport: lima-host child process spawned by trusted chrome (`LimaBridge.sys.mjs`) via Subprocess pipes.
Framing: 4-byte little-endian length + UTF-8 JSON (max 4 MiB). Host exits on stdin EOF.

Request  `{ "v": 1, "id": "7", "method": "agents.discover", "params": {...} }`
Response `{ "v": 1, "id": "7", "ok": true, "result": ... }` or `{ ..., "ok": false, "error": { "code", "message" } }`
Event    `{ "v": 1, "event": "terminal.output", "data": ... }`

| Method | Params | Result |
|---|---|---|
| `host.hello` | — | protocol, hostVersion, pid, methods |
| `host.ping` | — | pong, time |
| `agents.discover` | — | `CLICapabilityManifest[]` |
| `auth.evaluate` | `{ operation: ActionOperation, projectRoots: [path] }` | `AuthorizationResult` |

Error codes: `bad_request`, `unsupported_protocol_version`, `unknown_method`, `not_authorized`,
`confirmation_required`, `deadline_exceeded`, `internal_error`. Source of truth: `native/Sources/LimaProtocol`.
