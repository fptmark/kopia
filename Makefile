# Local dev pipeline for this checkout's gui/, server/ and gui-build/ submodules -- builds a
# kopia-server binary that actually embeds the current gui/ source, and the commands to put it in
# place of (and restart) the locally installed KopiaServer.app.
#
#   make build            gui/ -> gui-build/ -> a fresh server binary at dist/kopia-server
#   make build-gui        just the GUI, with a real version string instead of the unsubstituted
#                          %VITE_FULL_VERSION_INFO% placeholder a plain `npm run build` leaves
#   make sync-gui-build   copies gui/build into gui-build/build (same as the project's own
#                          push_local.sh, just pointed at this repo's actual sibling name)
#   make build-server     builds dist/kopia-server, with a GOWORK replace so it embeds gui-build's
#                          current working tree instead of the pinned release version in go.mod
#   make install-server   copies dist/kopia-server over the installed app's binary (does NOT touch
#                          the running process -- it keeps serving the old binary until restarted)
#   make stop-server      kills the running kopia-server process directly (not through `open`,
#                          which doesn't own the real process -- see the LaunchAgent plist)
#   make start-server     (re)loads the LaunchAgent fresh via bootout+bootstrap, so it picks up
#                          either an edited plist or (after install-server) a new binary
#   make restart-server   stop-server + start-server
#   make backup           a safe, consistent copy of the live task-history.db (VACUUM INTO, the
#                          same mechanism the server's own periodic backup uses -- fine to run
#                          while the server is up and actively writing) into backups/
#
# None of the server-affecting targets run automatically -- each is its own explicit step.

ROOT := $(CURDIR)
GUI_DIR := $(ROOT)/gui
GUI_BUILD_DIR := $(ROOT)/gui-build
SERVER_DIR := $(ROOT)/server
GOWORK_FILE := $(ROOT)/local.work
BUILT_BINARY := $(ROOT)/dist/kopia-server

INSTALLED_APP := $(HOME)/Applications/KopiaServer.app
INSTALLED_BINARY := $(INSTALLED_APP)/Contents/MacOS/kopia-server
LAUNCH_AGENT := $(HOME)/Library/LaunchAgents/com.markmalamut.kopia-server.plist
TASK_HISTORY_DB := $(HOME)/Library/Application Support/kopia/task-history.db
BACKUP_DIR := $(ROOT)/backups
BACKUP_FILE := $(BACKUP_DIR)/task-history-$(shell date +%Y%m%d-%H%M%S).db

# No timestamp here either, for the same reason as gui/vite.config.js's UI_VERSION: it ends up in the built
# binary, which gets re-signed on every install-server -- a timestamp would make that signature (and so the
# TCC/Full Disk Access grant tied to it) change on every build even when nothing actually changed.
VERSION_INFO := local build on $(shell hostname)

.PHONY: build build-gui sync-gui-build build-server install-server \
        stop-server start-server restart-server backup

build: build-gui sync-gui-build build-server

build-gui:
	cd $(GUI_DIR) && rm -rf build && VITE_FULL_VERSION_INFO="$(VERSION_INFO)" npm run build

sync-gui-build: build-gui
	rm -rf $(GUI_BUILD_DIR)/build
	cp -r $(GUI_DIR)/build $(GUI_BUILD_DIR)/build

build-server:
	mkdir -p $(ROOT)/dist
	cd $(SERVER_DIR) && GOWORK=$(GOWORK_FILE) go build -o $(BUILT_BINARY) .
	@echo "Built $(BUILT_BINARY)"

SIGNING_IDENTITY := Kopia Local Signing

install-server: build
	cp $(BUILT_BINARY) $(INSTALLED_BINARY)
	# Overwriting the binary leaves the bundle's _CodeSignature/CodeResources manifest (from the original
	# install) pointing at hashes that no longer match -- macOS then kills the process at launch with
	# OS_REASON_CODESIGNING instead of running it. Re-signing the whole bundle after every install keeps it
	# internally consistent. Signed with a stable local certificate (SIGNING_IDENTITY), not ad-hoc (`-`):
	# an ad-hoc signature's identity IS the binary's own hash, so it changes on every rebuild and macOS
	# treats each one as a new, untrusted app -- silently revoking Full Disk Access and every other TCC
	# grant each time. A certificate-backed identity stays the same across rebuilds, so grants persist.
	codesign --force --deep --sign "$(SIGNING_IDENTITY)" $(INSTALLED_APP)
	@echo "Installed into $(INSTALLED_BINARY) -- run 'make restart-server' to pick it up"

stop-server:
	-pkill -f '$(INSTALLED_BINARY)'

start-server:
	-launchctl bootout gui/$$(id -u) $(LAUNCH_AGENT)
	launchctl bootstrap gui/$$(id -u) $(LAUNCH_AGENT)

restart-server: stop-server start-server

backup:
	mkdir -p $(BACKUP_DIR)
	sqlite3 "$(TASK_HISTORY_DB)" "VACUUM INTO '$(BACKUP_FILE)'"
	@echo "Backed up to $(BACKUP_FILE)"
