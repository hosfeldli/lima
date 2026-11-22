# Repository Guidelines

## Project Structure

Lima 5 is a macOS browser and AI workspace built on Zen. Make browser changes in `browser/overlay/lima/`. Gecko modules and actors live there, while the `about:lima` UI and its assets live in `ui/`. The launcher and repack tooling live in `browser/launcher/` and `browser/scripts/`. The pinned Zen source is in `browser/zen-upstream/`.

Native SwiftPM targets live in `native/Sources/`, with matching test targets in `native/Tests/`. `LimaHost` builds the `lima-host` executable, and `LimaRuntime` composes the native services. See `protocols/ipc/bridge-v1.md` for the browser–native contract and `docs/architecture/` for implementation notes. `legacy/lima-4/` is the migration reference.

## Build, Test, and Run

Use macOS 14 or later and a Swift 6 toolchain. Run these commands from the repository root.

- `make bootstrap` initializes the pinned Zen submodule for upstream source work.
- `make native` builds the native Swift package.
- `make test` runs the native test suite.
- `make browser` repacks the pinned Zen release with the Lima overlay and host into `build/Lima.app`.
- `make run` repacks and launches Lima with the local `build/dev-profile`.
- `make lint` checks workflows and release scripts; `make release-rehearsal` builds a signed release locally without uploading. Releases follow `docs/RELEASING.md`.
- `python3 browser/scripts/source_smoke.py build/Lima.app` runs the headless identity and runtime smoke test that gates automatic releases.

The repack rebrands Zen as Lima inside `omni.ja` (`browser/scripts/rebrand_omni.py`). `zen-bump.yml` releases each new Zen tag automatically and commits to `main` as `github-actions[bot]`, so pull before starting work.

## Coding Style

Use four spaces in Swift and two in overlay JavaScript. Follow the existing UpperCamelCase Swift type names, lowerCamelCase functions, and `Lima*.sys.mjs` naming for Gecko service modules. Edit the UI source modules and `icons.json` directly. The repack script generates `bundle.js` and `icons.js`. Keep bridge changes consistent with the protocol document.

## Testing

Use Swift Testing (`@Test`, `#expect`) in the matching `*Tests.swift` file. Name tests for the behavior they verify, such as `workspaceBindsFolderTerminalAndAgent`. Run a focused check with `swift test --package-path native --filter WorkspaceTests`. For browser changes, use `make run` and exercise the affected flow in the development profile.

## Commits and Pull Requests

Use short, imperative commit subjects, following examples such as “Add encrypted local store and Notes 5.0 service.” In pull requests, summarize the behavior change, list the checks you ran, link related issues when available, and include screenshots for visible UI changes.
