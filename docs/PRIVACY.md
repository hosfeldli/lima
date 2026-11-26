# Lima privacy

Lima is built so your browsing, notes and AI work stay on your Mac.

## What stays on your Mac
- **Notes, chats, workspace history, activity and Companion memory** are kept in an encrypted local store whose key lives in your macOS Keychain. Lima has no account and no cloud copy. You can export a recovery key in Settings → Data & permissions.
- **Backups and export.** Lima keeps a week of daily backups of the encrypted store under its data folder (`snapshots/`, still encrypted). Settings → Data & permissions restores one at the next start, or exports notes as Markdown and workspaces as JSON to a folder you choose.
- **Problem reports** (Settings → Help & support) are written to `~/Library/Logs/Lima/Reports/` with email addresses, tokens, URL queries and the home path removed, then opened as an email draft. Nothing is sent unless you send it.
- **Update rollout.** Each install keeps a random number in `Updates/rollout-slot` to take staged releases at its own time. It never leaves the Mac.
- **Private windows** are never recorded in activity, never shown to agents, and never share media with the sidebar's music controls.
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

## No usage statistics
Lima doesn't collect usage statistics, analytics or telemetry. Earlier versions could send anonymous daily feature counts; Lima 5.0.10 removed that entirely and deletes any counts left on your Mac.

## Search
Google is the default search engine for new installs. You can choose another in Settings → Search at any time; Lima never changes your choice.
