.DEFAULT_GOAL := help
.PHONY: help bootstrap native test browser run lint release-check release-rehearsal clean

help:
	@echo "make bootstrap  init submodules (Zen pinned in browser/lima.lock.json)"
	@echo "make native     build the Swift native runtime"
	@echo "make test       run native tests"
	@echo "make browser    repack the pinned Zen release into build/Lima.app"
	@echo "make run        build and launch Lima with a disposable dev profile"
	@echo "make lint       lint workflows and release scripts"
	@echo "make release-rehearsal  signed local release build + updater integration tests (no upload)"
	@echo "Releases: browser/scripts/release/release.sh help, docs/RELEASING.md"

bootstrap:
	git submodule update --init --depth 1

native:
	swift build --package-path native

test:
	swift test --package-path native

browser:
	browser/scripts/repack.sh

run: browser
	mkdir -p build/dev-profile
	build/Lima.app/Contents/MacOS/lima -profile "$(CURDIR)/build/dev-profile" -no-remote

lint:
	actionlint .github/workflows/*.yml
	shellcheck --severity=warning browser/scripts/*.sh browser/scripts/release/*.sh
	python3 -m py_compile browser/scripts/lima_codesign.py browser/scripts/bundle_ui.py
	browser/scripts/release/release.sh check

release-check:
	browser/scripts/release/release.sh check

release-rehearsal: browser
	browser/scripts/release/release.sh rehearse
	rm -rf build/rehearsal-candidate && mkdir -p build/rehearsal-candidate
	ditto -x -k dist/v$$(cat VERSION)/Lima-$$(cat VERSION).zip build/rehearsal-candidate
	LIMA_TEST_SIGNED_APP="$(CURDIR)/build/release/Lima.app" \
	LIMA_TEST_CANDIDATE_APP="$(CURDIR)/build/rehearsal-candidate/Lima.app" \
	LIMA_TEST_ADHOC_APP="$(CURDIR)/build/Lima.app" \
	swift test --package-path native --filter "[Uu]pdate|adHoc|installer"

clean:
	rm -rf build dist native/.build
