# Lima privacy

Lima is built so your browsing, notes and AI work stay on your Mac.

## What stays on your Mac
- **Notes, chats, workspace history, activity and Companion memory** are kept in an encrypted local store whose key lives in your macOS Keychain. Lima has no account and no cloud copy. You can export a recovery key in Settings → Data & permissions.
- **Private windows** are never recorded in activity, never counted in usage statistics, never shown to agents, and never share media with the sidebar's music controls.
- **Page cleanup** (hiding search engines' AI answers and sponsored results, and YouTube Shorts) runs entirely in the browser. It sends nothing anywhere.

## What leaves your Mac
- **Your AI provider** (Claude Code, Codex or OpenCode) receives your messages and attachments, plus what agents read while working for you: pages and files they open, notes they read, and any screenshots or location you approve. This is under that provider's own terms. Lima doesn't proxy these requests or keep a copy on any server.
- **Companion memory** (on by default): once a day it sends your requests and recorded activity since its last update to your default AI, which writes short notes. Turn it off in Settings → Personal Memory.
- **Websites** you visit, as in any browser. Link previews and images you add to notes are fetched once from their site, without cookies.
- **Your search engine** receives what you type into Lima Search, for suggestions, outside private windows (Settings turns suggestions off).
- **Google**, only if you connect Gmail and Calendar: read-only access you grant. Counts, upcoming meetings and mail previews stay on your Mac.
- **Apple**, only if you use them: audio for Apple Speech dictation (the default dictation runs on your Mac), and Location Services when an agent's location request is approved (it gets an estimate rounded to about 1.5 km).
- **Shared note links** carry the note itself after the `#` of a lima.liamhosfeld.com/n link. Browsers don't send that part to the server, so nothing is uploaded; anyone with the link can read the note (images are left out).
- **Update checks** fetch a signed feed and the update from Lima's update storage. They send no identifiers.
- **Firefox's safety services** (such as Safe Browsing) work as in Firefox. Firefox telemetry is turned off.

## Agents and outside AI tools
Agents and AI tools connected over MCP can't read your chats, take screenshots, open apps, export keys or change settings without your approval. The approval card says who is asking and what for. Reads of notes, search and activity by outside tools follow the grants in Settings → Data & permissions.

## Anonymous usage statistics (on unless you turn it off)
Lima tells you once, in the sidebar, with a **Turn Off** button, and Settings → Privacy turns it off at any time. If you turned it down before 5.0.8, it stays off. While it's on, Lima sends **one report a day** with:
- how many times each feature was used, from a fixed list (for example `search.opened`, `chat.sent`, `workspace.created`);
- the Lima version and build, and the macOS version;
- the region from macOS's language settings (for example `US`);
- a few settings: light or dark mode, tab size (compact, default or large), and whether AI answers, ads and Shorts are hidden and Lima Search is the address bar, plus which AI provider you use, but only once you've said yes (OK on the notice, or turning it on in Settings);
- a random ID that changes every month.

It never sends web addresses, page content, searches, chat or note text, file names, accounts, contacts, or anything about private windows. The collector doesn't store IP addresses or request logs. Reports are kept in a private bucket for at most 13 months.

Settings → Privacy shows the exact report before it's sent, turns sharing off (which also discards anything not yet sent), and **Delete my data** removes every report sent under the current ID.

The collector's source is in `infra/usage/`.
