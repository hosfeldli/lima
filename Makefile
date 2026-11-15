.DEFAULT_GOAL := help
.PHONY: help bootstrap native test browser run clean

help:
	@echo "make bootstrap  init submodules (Zen pinned in browser/lima.lock.json)"
	@echo "make native     build the Swift native runtime"
	@echo "make test       run native tests"
	@echo "make browser    repack the pinned Zen release into build/Lima.app"
	@echo "make run        build and launch Lima with a disposable dev profile"

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

clean:
	rm -rf build native/.build
