
// Remote debugging is off in stable builds. The runtime also refuses browser
// authority if remote tooling is active.
lockPref("lima.release.hardened", true);
lockPref("devtools.chrome.enabled", false);
lockPref("devtools.debugger.remote-enabled", false);
lockPref("devtools.debugger.prompt-connection", true);
