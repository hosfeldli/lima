# Lima 4.x → 5.0 migration map

`legacy/lima-4` is ray-placement imported with full history (git subtree). It still builds on its own
(`make -C legacy/lima-4 build`) and stays the 4.x maintenance line. Services move into `native/` one at
a time behind LimaProtocol contracts; nothing is deleted from legacy until its replacement passes the
milestone exit gate.

| 4.x area (`legacy/lima-4/Sources/RayPlacement`) | 5.0 destination | Milestone |
|---|---|---|
| Developer Terminal (SwiftTerm) | terminal-service + sidebar terminal | 3 |
| AIProvider*, AIExecution*, OpenCode adapter | AgentSupervisor CLI adapters (direct API backends removed) | 1, 3 |
| AIRecovery*, AIProviderFailure* | Message-level recoverable errors (§5.5) | 1 |
| Notes + Markdown editor | notes-service, classic + canvas (§6); undo crash fix first | 1, 4 |
| Launcher/search, extensions | Universal Search + built-in commands; extension platform retired (§5.4) | 3 |
| Dictation (Whisper runtime) | audio-service | 6 |
| Screenshot tools | screen-service + Screenshot Studio | 6 |
| Plaintext Application Support/Lima data | Encrypted store with verified migration (§7) | 4 |
