# Lima 5.0

A macOS-native browser and AI workspace built on a Zen Browser fork. Spec: `docs/spec/`.

```
browser/   zen-upstream (pinned submodule), overlay/ (Lima chrome), launcher/, scripts/
native/    Swift runtime: LimaProtocol, LimaAuthorization, LimaTerminal, LimaAgentSupervisor, lima-host
protocols/ browser ↔ native bridge contract
legacy/    Lima 4.x (ray-placement) with full history — migration source
docs/      spec, build, Orca port, migration map
```

## Quick start
```sh
make bootstrap   # fetch pinned Zen source
make test        # native tests
make run         # build/Lima.app from the pinned Zen release + Lima overlay, launch with a dev profile
```
See `docs/architecture/build.md` for how the repack works and why it isn't a source build, and
`docs/RELEASING.md` for signing, the update feed and the release workflow.

Third-party: Zen Browser (MPL-2.0), Firefox (MPL-2.0); Orca (MIT) informs the agent-runtime design.
