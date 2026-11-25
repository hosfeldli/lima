# Lima 4.x → 5.0 migration map

The Lima 4.x source (ray-placement) was kept in `legacy/lima-4` until every service below had moved
into `native/`; it was removed after 5.0.7. Its history stays in the ray-placement repository and in this
repository's history before that removal. The whisper-cli binary it shipped now lives in `browser/vendor/whisper/`.

| 4.x area (`Sources/RayPlacement`) | 5.0 destination | Milestone |
|---|---|---|
| Developer Terminal (SwiftTerm) | terminal-service + sidebar terminal | 3 |
| AIProvider*, AIExecution*, OpenCode adapter | AgentSupervisor CLI adapters (direct API backends removed) | 1, 3 |
| AIRecovery*, AIProviderFailure* | Message-level recoverable errors (§5.5) | 1 |
| Notes + Markdown editor | notes-service, classic + canvas (§6); undo crash fix first | 1, 4 |
| Launcher/search, extensions | Universal Search + built-in commands; extension platform retired (§5.4) | 3 |
| Dictation (Whisper runtime) | audio-service | 6 |
| Screenshot tools | screen-service + Screenshot Studio | 6 |
| Plaintext Application Support/Lima data | Encrypted store with verified migration (§7) | 4 |
