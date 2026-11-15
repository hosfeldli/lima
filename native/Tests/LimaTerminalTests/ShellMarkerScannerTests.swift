import Foundation
import Testing
@testable import LimaTerminal

private func bytes(_ s: String) -> [UInt8] { Array(s.utf8) }

@Test func stripsMarkersAndReportsEvents() {
    var scanner = ShellMarkerScanner()
    let (out, events) = scanner.feed(bytes("ls\r\n\u{1B}]777;lima;preexec\u{07}a b\r\n\u{1B}]777;lima;prompt;0\u{07}$ "))
    #expect(String(decoding: out, as: UTF8.self) == "ls\r\na b\r\n$ ")
    #expect(events == [.commandStarted(command: nil), .promptReady(exitStatus: 0)])
}

@Test func handlesMarkerSplitAcrossChunks() {
    var scanner = ShellMarkerScanner()
    let whole = bytes("x\u{1B}]777;lima;prompt;127\u{1B}\\y")
    var output: [UInt8] = []
    var events: [ShellIntegrationEvent] = []
    for byte in whole {
        let (o, e) = scanner.feed([byte])
        output += o; events += e
    }
    #expect(String(decoding: output, as: UTF8.self) == "xy")
    #expect(events == [.promptReady(exitStatus: 127)])
}

@Test func unrelatedEscapeSequencesPassThrough() {
    var scanner = ShellMarkerScanner()
    let input = bytes("\u{1B}[31mred\u{1B}[0m \u{1B}]0;title\u{07}")
    let (out, events) = scanner.feed(input)
    #expect(out == input)
    #expect(events.isEmpty)
}

@Test func preexecCarriesBase64Command() {
    var scanner = ShellMarkerScanner()
    let encoded = Data("git status".utf8).base64EncodedString()
    let (_, events) = scanner.feed(bytes("\u{1B}]777;lima;preexec;\(encoded)\u{07}"))
    #expect(events == [.commandStarted(command: "git status")])
}
