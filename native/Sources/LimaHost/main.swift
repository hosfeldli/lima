import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaProtocol

let hostVersion = "5.0.0-dev"

/// Methods served over the browser bridge. Kept as an explicit list so
/// host.hello can advertise them and anything else fails as unknown_method.
let bridgeMethods = ["host.hello", "host.ping", "agents.discover", "auth.evaluate"]

struct AuthEvaluateParams: Decodable {
    var operation: ActionOperation
    var projectRoots: [String]
}

func handle(_ request: BridgeRequest) async -> BridgeResponse {
    guard request.v == limaBridgeProtocolVersion else {
        return .failure(id: request.id, BridgeError(.unsupportedProtocolVersion, "host speaks v\(limaBridgeProtocolVersion), got v\(request.v)"))
    }
    do {
        switch request.method {
        case "host.hello":
            return .success(id: request.id, .object([
                "protocol": .number(Double(limaBridgeProtocolVersion)),
                "hostVersion": .string(hostVersion),
                "pid": .number(Double(ProcessInfo.processInfo.processIdentifier)),
                "methods": .array(bridgeMethods.map(JSONValue.string))
            ]))
        case "host.ping":
            return .success(id: request.id, .object(["pong": .bool(true), "time": .number(Date().timeIntervalSince1970)]))
        case "agents.discover":
            return .success(id: request.id, try JSONValue.from(await CLIDiscovery().discoverAll()))
        case "auth.evaluate":
            guard let params = request.params else { throw BridgeError(.badRequest, "auth.evaluate requires params") }
            let decoded = try params.decode(as: AuthEvaluateParams.self)
            let broker = AuthorizationBroker(projectRoots: decoded.projectRoots.map { URL(fileURLWithPath: $0) })
            return .success(id: request.id, try JSONValue.from(await broker.evaluate(decoded.operation)))
        default:
            return .failure(id: request.id, BridgeError(.unknownMethod, request.method))
        }
    } catch let error as BridgeError {
        return .failure(id: request.id, error)
    } catch is DecodingError {
        return .failure(id: request.id, BridgeError(.badRequest, "invalid params for \(request.method)"))
    } catch {
        return .failure(id: request.id, BridgeError(.internalError, String(describing: error)))
    }
}

/// Serializes writes to stdout so concurrent responses never interleave.
actor FrameWriter {
    private let output = FileHandle.standardOutput
    private let encoder = JSONEncoder()

    func send<T: Encodable>(_ message: T) {
        guard let payload = try? encoder.encode(message) else { return }
        output.write(BridgeFrame.encode(payload))
    }
}

func runStdioBridge() async {
    let writer = FrameWriter()
    var decoder = BridgeFrame.Decoder()
    let input = FileHandle.standardInput

    // The browser owns our stdin. EOF means the browser went away, so the
    // host exits instead of lingering as an orphan (spec §15, Terminal).
    let chunks = AsyncStream<Data> { continuation in
        Thread.detachNewThread {
            while true {
                let data = input.availableData
                if data.isEmpty { continuation.finish(); return }
                continuation.yield(data)
            }
        }
    }

    await withTaskGroup(of: Void.self) { group in
        for await chunk in chunks {
            let payloads: [Data]
            do {
                payloads = try decoder.append(chunk)
            } catch {
                await writer.send(BridgeEvent(event: "host.protocolError", data: .string(String(describing: error))))
                continue
            }
            for payload in payloads {
                guard let request = try? JSONDecoder().decode(BridgeRequest.self, from: payload) else {
                    await writer.send(BridgeResponse.failure(id: "", BridgeError(.badRequest, "malformed request envelope")))
                    continue
                }
                group.addTask { await writer.send(await handle(request)) }
            }
        }
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "--stdio":
    await runStdioBridge()
case "discover":
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let manifests = await CLIDiscovery().discoverAll()
    print(String(decoding: try encoder.encode(manifests), as: UTF8.self))
case "--version":
    print("lima-host \(hostVersion) (bridge protocol v\(limaBridgeProtocolVersion))")
default:
    FileHandle.standardError.write(Data("usage: lima-host --stdio | discover | --version\n".utf8))
    exit(64)
}
