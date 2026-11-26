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
case "chunk-manifest":
    // Release tooling: lima-host chunk-manifest <Lima.app> <out-directory>
    guard arguments.count == 3 else { print("usage: lima-host chunk-manifest <app> <out>"); exit(64) }
    let out = URL(fileURLWithPath: arguments[2])
    do {
        let manifest = try ChunkManifest.make(app: URL(fileURLWithPath: arguments[1]), chunkDirectory: out.appendingPathComponent("chunks"))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(manifest).write(to: out.appendingPathComponent("manifest.json"))
        let packed = manifest.sizes.values.reduce(0) { $0 + ($1.last ?? 0) }
        print("\(manifest.files.count) files, \(manifest.sizes.count) chunks, \(packed / 1_048_576) MB compressed")
    } catch {
        FileHandle.standardError.write(Data("chunk-manifest: \(error)\n".utf8))
        exit(1)
    }
case "chunk-assemble":
    // Release check: lima-host chunk-assemble <manifest-dir> <installed.app> <out.app>
    guard arguments.count == 4 else { print("usage: lima-host chunk-assemble <dir> <installed> <out>"); exit(64) }
    do {
        let dir = URL(fileURLWithPath: arguments[1])
        let manifest = try JSONDecoder().decode(ChunkManifest.self, from: Data(contentsOf: dir.appendingPathComponent("manifest.json")))
        let installed = ChunkUpdate.index(URL(fileURLWithPath: arguments[2]))
        let plan = manifest.download(from: installed)
        let total = manifest.sizes.values.reduce(0) { $0 + ($1.last ?? 0) }
        try await ChunkUpdate.assemble(manifest, into: URL(fileURLWithPath: arguments[3]), installed: installed) { digest in
            try Data(contentsOf: dir.appendingPathComponent("chunks/\(digest).z"))
        }
        print("downloaded \(plan.chunks.count) of \(manifest.sizes.count) chunks: \(plan.bytes / 1_048_576) MB of \(total / 1_048_576) MB")
    } catch {
        FileHandle.standardError.write(Data("chunk-assemble: \(error)\n".utf8))
        exit(1)
    }
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
