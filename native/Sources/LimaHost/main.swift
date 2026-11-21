import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaProtocol
import LimaRuntime

let arguments = Array(CommandLine.arguments.dropFirst())

switch arguments.first {
case "daemon":
    await Daemon.run()
case "grammar-shortcut":
    GrammarShortcut.run()
case "--stdio":
    StdioRelay.run()
case "mcp":
    MCPServer.run()
case "apply-update":
    UpdateApplier.run(Array(arguments.dropFirst()))
case "discover":
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(await CLIDiscovery().discoverAll()), as: UTF8.self))
case "call":
    // Developer utility: lima-host call <method> ['{"json":"params"}']
    guard arguments.count >= 2 else { print("usage: lima-host call <method> [json]"); exit(64) }
    let params = arguments.count > 2 ? try JSONDecoder().decode(JSONValue.self, from: Data(arguments[2].utf8)) : nil
    do {
        // Developer utility. Release builds always use the least-privileged
        // origin; the runtime rejects a claimed browser origin regardless.
        #if DEBUG
        let origin = ActionOrigin(rawValue: ProcessInfo.processInfo.environment["LIMA_CALL_ORIGIN"] ?? "mcp") ?? .mcp
        #else
        let origin = ActionOrigin.mcp
        #endif
        let client = try RuntimeClient.connect(origin: origin)
        let result = try client.call(arguments[1], params: params)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        print(String(decoding: try encoder.encode(result), as: UTF8.self))
    } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
    }
case "--version":
    print("lima-host \(limaRuntimeVersion) (bridge protocol v\(limaBridgeProtocolVersion))")
default:
    FileHandle.standardError.write(Data("""
    usage: lima-host <command>
      daemon      run the Lima runtime (normally started automatically or by launchd)
      --stdio     browser bridge relay (used by Lima Browser)
      mcp         MCP server over stdio for external agents
      discover    print installed AI CLIs
      call        call a runtime method (development)

    """.utf8))
    exit(64)
}
