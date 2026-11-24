# dmgbuild settings for Lima's installer window: the app on the left, an
# Applications shortcut on the right, an arrow and one line of instructions
# (browser/branding/dmg, drawn by dmg_background.swift). Values come from
# release.sh with -D app=… -D background=… -D icon=….
# ruff: noqa: F821  (dmgbuild injects `defines`)
import os.path

application = defines["app"]
name = os.path.basename(application)

format = "ULFO"            # LZFSE: smaller than zlib, opens on every supported macOS
filesystem = "HFS+"
files = [application]
symlinks = {"Applications": "/Applications"}
hide_extensions = [name]
icon = defines.get("icon")  # volume icon shown on the desktop and in Finder's sidebar

background = defines["background"]
window_rect = ((200, 140), (640, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
arrange_by = None
icon_size = 128
text_size = 13
icon_locations = {name: (170, 185), "Applications": (470, 185)}
