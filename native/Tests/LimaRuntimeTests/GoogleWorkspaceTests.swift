import Foundation
import Testing
import LimaAgentSupervisor
@testable import LimaRuntime

@Test func oauthHandoffUsesOnlyTheExpectedHTTPSHost() {
    let allowed = Set(["accounts.google.com"])
    #expect(SetupSessions.signInURL("Open https://accounts.google.com/o/oauth2/auth?state=sample", allowedHosts: allowed) ==
        "https://accounts.google.com/o/oauth2/auth?state=sample")
    #expect(SetupSessions.signInURL("Open https://accounts.google.com.example.test/oauth", allowedHosts: allowed) == nil)
    #expect(SetupSessions.signInURL("Open http://accounts.google.com/oauth", allowedHosts: allowed) == nil)
    #expect(SetupSessions.signInURL("Open https://user@accounts.google.com/oauth", allowedHosts: allowed) == nil)
}

@Test func googleWorkspaceReadsMetadataAndFlagsExpiredConnections() async throws {
    let (runtime, directory) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("gws")
    let meeting = Date().addingTimeInterval(300).ISO8601Format()
    let started = Date().addingTimeInterval(-30).ISO8601Format()
    try """
    #!/bin/sh
    if [ -f "${0}.expired" ]; then echo '401 unauthenticated'; exit 1; fi
    echo 'Using cached discovery metadata' >&2
    if [ "$1" = "calendar" ] && [ -f "${0}.calendar-disabled" ]; then
      echo '{"error":{"message":"API is disabled","reason":"accessNotConfigured"}}'; exit 1
    fi
    case "$1 $2 $3 $4" in
      'gmail users labels get') echo '{"messagesUnread":7}' ;;
      'gmail users messages list') echo '{"messages":[{"id":"message"}],"resultSizeEstimate":1}' ;;
      'gmail users messages get') echo '{"id":"message","threadId":"thread","internalDate":"1760000000000","payload":{"headers":[{"name":"From","value":"Fixture sender"},{"name":"subject","value":"Fixture subject"}]}}' ;;
      'calendar events list --params') echo '{"items":[{"id":"soon","summary":"Smoke test","start":{"dateTime":"\(meeting)"}},{"id":"now","start":{"dateTime":"\(started)"},"end":{"dateTime":"\(meeting)"}},{"id":"declined","start":{"dateTime":"\(started)"},"attendees":[{"self":true,"responseStatus":"declined"}]},{"id":"all-day","start":{"date":"2027-01-02"}}]}' ;;
      *) exit 9 ;;
    esac
    """.write(to: file, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    let service = GoogleWorkspace(discovery: CLIDiscovery(searchPaths: [directory.path, "/bin"]))
    let disabled = try await service.refresh(store: runtime.store, force: true)
    #expect(disabled.installed && !disabled.enabled && disabled.unread == nil)
    _ = try await service.configure(true, store: runtime.store)
    let connected = try await service.refresh(store: runtime.store, force: true)
    #expect(connected.mail == "connected" && connected.calendar == "connected")
    #expect(connected.unread == 7 && connected.meeting?.title == "Smoke test")
    #expect(connected.meetings?.map(\.id) == ["now", "soon"])
    #expect(connected.meetings?.first?.endsAt != nil)
    #expect(connected.mailPreviews?.first?.subject == "Fixture subject")
    #expect(connected.mailPreviews?.first?.sender == "Fixture sender")
    #expect(connected.mailPreviews?.first?.link == "https://mail.google.com/mail/u/0/#inbox/thread")
    try Data().write(to: directory.appendingPathComponent("gws.calendar-disabled"))
    let partial = try await service.refresh(store: runtime.store, force: true)
    #expect(partial.mail == "connected" && partial.calendar == "setup")
    #expect(partial.calendarIssue == "apiDisabled" && partial.meeting == nil)
    try Data().write(to: directory.appendingPathComponent("gws.expired"))
    let expired = try await service.refresh(store: runtime.store, force: true)
    #expect(expired.mailReconnect && expired.calendarReconnect)
    #expect(expired.unread == nil && expired.meeting == nil)
    let (refreshed, _) = try await answeringApproval(runtime, approve: false) { await call(runtime, "integrations.google.refresh", origin: .mcp) }
    #expect(refreshed.error?.code == .notAuthorized)
}
