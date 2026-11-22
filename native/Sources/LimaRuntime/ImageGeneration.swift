import CryptoKit
import Foundation
import LimaProtocol

struct ImageGenerationSettings: Codable, Sendable {
    var port = 8188
    var checkpoint = ""
    var steps = 24
    var allowAgents = false

    static let key = "image.generation.comfyui"

    init() {}

    init(_ params: JSONValue?) throws {
        port = try ImageRaster.integer(params, "port")
        steps = try ImageRaster.integer(params, "steps")
        checkpoint = try params.string("checkpoint").trimmingCharacters(in: .whitespacesAndNewlines)
        allowAgents = params.bool("allow_agents", default: false)
        guard (1024...65535).contains(port), (1...60).contains(steps), checkpoint.utf8.count <= 240,
              !checkpoint.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ImageRaster.invalid("Choose an installed checkpoint, a local port, and 1–60 sampling steps.")
        }
    }

    var publicView: JSONValue {
        .object(["provider": .string("comfyui"), "port": .number(Double(port)), "checkpoint": .string(checkpoint),
                 "steps": .number(Double(steps)), "allow_agents": .bool(allowAgents), "configured": .bool(!checkpoint.isEmpty)])
    }
}

struct ImageGenerationRequest: Codable, Equatable, Sendable {
    let prompt: String
    let negative_prompt: String
    let width: Int
    let height: Int
    let count: Int
    let seed: Int
    let output_name: String
    let show_in_workspace: Bool

    init(_ params: JSONValue?) throws {
        let fields = Set(["workspace_id", "prompt", "negative_prompt", "width", "height", "count", "seed",
                          "output_name", "idempotency_key", "show_in_workspace"])
        guard let args = params?.objectValue, Set(args.keys).isSubset(of: fields) else {
            throw ImageRaster.invalid("Generation accepts a text prompt and local output settings.")
        }
        prompt = try params.string("prompt").trimmingCharacters(in: .whitespacesAndNewlines)
        negative_prompt = params.optionalString("negative_prompt") ?? ""
        width = try params?["width"].map { _ in try ImageRaster.integer(params, "width") } ?? 768
        height = try params?["height"].map { _ in try ImageRaster.integer(params, "height") } ?? 768
        count = try params?["count"].map { _ in try ImageRaster.integer(params, "count") } ?? 1
        seed = try params?["seed"].map { _ in try ImageRaster.integer(params, "seed") } ?? Int.random(in: 0..<1_000_000_000)
        output_name = try params.string("output_name")
        show_in_workspace = params.bool("show_in_workspace", default: false)
        guard (1...4000).contains(prompt.utf8.count), negative_prompt.utf8.count <= 2000,
              (256...1536).contains(width), (256...1536).contains(height),
              width.isMultiple(of: 8), height.isMultiple(of: 8), (1...4).contains(count), width * height * count <= 4_000_000,
              (0...9_007_199_254_740_991).contains(seed), output_name.lowercased().hasSuffix(".png") else {
            throw ImageRaster.invalid("Provide a prompt, a .png destination, and 1–4 images with dimensions divisible by eight within 256–1,536 pixels.")
        }
    }

    func filename(_ index: Int) -> String {
        count == 1 ? output_name : String(output_name.dropLast(4)) + "-\(index + 1).png"
    }
}

protocol ImageGenerationProvider: Sendable {
    func checkpoints() async throws -> [String]
    func submit(_ request: ImageGenerationRequest, settings: ImageGenerationSettings) async throws -> String
    func result(_ id: String) async throws -> [Data]?
}

private final class NoComfyRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct ComfyImageProvider: ImageGenerationProvider {
    let port: Int

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 12
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config, delegate: NoComfyRedirects(), delegateQueue: nil)
    }()

    func checkpoints() async throws -> [String] {
        let info = try await json("/object_info/CheckpointLoaderSimple")
        let schema = info["CheckpointLoaderSimple"]?["input"]?["required"]?["ckpt_name"]?.arrayValue ?? []
        let models = schema.first?.arrayValue ?? schema.dropFirst().first?["options"]?.arrayValue
        return Array((models ?? []).compactMap(\.stringValue).prefix(200))
    }

    func submit(_ request: ImageGenerationRequest, settings: ImageGenerationSettings) async throws -> String {
        func output(_ node: String, _ port: Int = 0) -> JSONValue { .array([.string(node), .number(Double(port))]) }
        func node(_ type: String, _ inputs: [String: JSONValue]) -> JSONValue { .object(["class_type": .string(type), "inputs": .object(inputs)]) }
        let workflow: [String: JSONValue] = [
            "1": node("CheckpointLoaderSimple", ["ckpt_name": .string(settings.checkpoint)]),
            "2": node("CLIPTextEncode", ["clip": output("1", 1), "text": .string(request.prompt)]),
            "3": node("CLIPTextEncode", ["clip": output("1", 1), "text": .string(request.negative_prompt)]),
            "4": node("EmptyLatentImage", ["width": .number(Double(request.width)), "height": .number(Double(request.height)),
                                           "batch_size": .number(Double(request.count))]),
            "5": node("KSampler", ["model": output("1"), "positive": output("2"), "negative": output("3"), "latent_image": output("4"),
                                   "seed": .number(Double(request.seed)), "steps": .number(Double(settings.steps)), "cfg": .number(7),
                                   "sampler_name": .string("euler"), "scheduler": .string("normal"), "denoise": .number(1)]),
            "6": node("VAEDecode", ["samples": output("5"), "vae": output("1", 2)]),
            "7": node("SaveImage", ["images": output("6"), "filename_prefix": .string("Lima-" + UUID().uuidString)]),
        ]
        let response = try await json("/prompt", post: .object(["prompt": .object(workflow)]))
        guard let id = response["prompt_id"]?.stringValue, UUID(uuidString: id) != nil else {
            throw ImageRaster.invalid("ComfyUI did not accept the workflow. Check the checkpoint and model compatibility.")
        }
        return id
    }

    func result(_ id: String) async throws -> [Data]? {
        let history = try await json("/history/" + id)
        guard let record = history[id] else { return nil }
        let state = record["status"]
        if state?["status_str"]?.stringValue == "error" {
            throw ImageRaster.invalid("ComfyUI could not run this workflow. Check the model and its local runtime log.")
        }
        guard let images = record["outputs"]?["7"]?["images"]?.arrayValue else {
            if state?["completed"]?.boolValue == true { throw ImageRaster.invalid("ComfyUI finished without an image.") }
            return nil
        }
        guard (1...4).contains(images.count) else { throw ImageRaster.invalid("ComfyUI returned an unexpected number of images.") }
        var output: [Data] = []
        for image in images {
            let filename = try Optional(image).string("filename")
            let folder = image["subfolder"]?.stringValue ?? ""
            guard !filename.isEmpty, filename.utf8.count <= 255, !filename.contains("/"), !filename.contains("\\"),
                  folder.isEmpty, image["type"]?.stringValue == "output" else {
                throw ImageRaster.invalid("ComfyUI returned an unsupported artifact reference.")
            }
            let query = [URLQueryItem(name: "filename", value: filename), URLQueryItem(name: "type", value: "output")]
            output.append(try await fetch("/view", query: query, limit: ImageRaster.maxFileBytes))
        }
        return output
    }

    private func json(_ path: String, post: JSONValue? = nil) async throws -> JSONValue {
        let data = try await fetch(path, post: post, limit: 1_000_000)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    private func fetch(_ path: String, query: [URLQueryItem] = [], post: JSONValue? = nil, limit: Int) async throws -> Data {
        var address = URLComponents()
        address.scheme = "http"
        address.host = "127.0.0.1"
        address.port = port
        address.path = path
        if !query.isEmpty { address.queryItems = query }
        guard let url = address.url else { throw ImageRaster.invalid("Invalid local ComfyUI address.") }
        var request = URLRequest(url: url)
        if let post {
            request.httpMethod = "POST"
            request.httpBody = try JSONEncoder().encode(post)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            let (stream, response) = try await Self.session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
                throw ImageRaster.invalid("ComfyUI rejected the request. Check the installed checkpoint and local server log.")
            }
            guard response.expectedContentLength <= Int64(limit) else { throw ImageRaster.invalid("The provider output exceeds the size limit.") }
            var data = Data()
            for try await byte in stream {
                guard data.count < limit else { throw ImageRaster.invalid("The provider output exceeds the size limit.") }
                data.append(byte)
            }
            return data
        } catch let error as BridgeError { throw error }
        catch is CancellationError { throw CancellationError() }
        catch { throw ImageRaster.invalid("Lima could not reach local ComfyUI on port \(port).") }
    }
}

actor ImageGeneration {
    private struct Job: Codable {
        let id: String
        let workspace: String
        let parameters: JSONValue
        let request: ImageGenerationRequest
        let model: String
        let createdAt: Date
        var status: String
        var providerID: String?
        var artifacts: [String] = []
        var documents: [JSONValue] = []
        var error: String?
    }

    private let root: URL
    private var work: [String: Task<Void, Never>] = [:]

    init(root: URL) { self.root = root }

    func start(params: JSONValue?, workspace: Workspace, settings: ImageGenerationSettings,
               provider: ImageGenerationProvider,
               checkAccess: @escaping @Sendable () async throws -> Void = {},
               prepare: @escaping @Sendable (String, Bool) async throws -> JSONValue) throws -> JSONValue {
        guard !settings.checkpoint.isEmpty else { throw ImageRaster.invalid("Configure a local image checkpoint in Settings → Image Generation.") }
        let key = try params.string("idempotency_key")
        guard (1...128).contains(key.utf8.count), let params else { throw ImageRaster.invalid("Provide a generation idempotency key.") }
        let id = SHA256.hash(data: Data((workspace.id + "\0" + key).utf8)).map { String(format: "%02x", $0) }.joined()
        if let job = try? read(id, workspace: workspace.id) {
            guard job.parameters == params else { throw ImageRaster.invalid("That generation key already identifies another request.") }
            return publicView(job)
        }
        guard work.isEmpty else { throw ImageRaster.invalid("A local generation job is already running. Check its status first.") }
        let request = try ImageGenerationRequest(params)
        for i in 0..<request.count { try ImageWorkspaceFiles.verifyNewOutput(root: workspace.directory, path: request.filename(i)) }
        let job = Job(id: id, workspace: workspace.id, parameters: params, request: request,
                      model: settings.checkpoint, createdAt: Date(), status: "queued")
        try save(job)
        try? StudioRecent.record(id, workspace: workspace.id, root: root)
        work[id] = Task { await self.run(job, directory: workspace.directory, settings: settings, provider: provider,
                                        checkAccess: checkAccess, prepare: prepare) }
        return publicView(job)
    }

    func status(_ id: String, workspace: String) throws -> JSONValue {
        publicView(try read(id, workspace: workspace))
    }

    func latest(workspace: String) throws -> JSONValue {
        guard let id = StudioRecent.read(workspace: workspace, root: root) else { return .null }
        return try status(id, workspace: workspace)
    }

    func cancel(_ id: String, workspace: String) throws -> JSONValue {
        var job = try read(id, workspace: workspace)
        if ["queued", "running"].contains(job.status), let task = work[id] {
            job.status = "canceled"
            job.error = "Lima stopped importing results. A submitted workflow may still finish in ComfyUI."
            try save(job)
            task.cancel()
        }
        return publicView(job)
    }

    private func run(_ initial: Job, directory: String, settings: ImageGenerationSettings, provider: ImageGenerationProvider,
                     checkAccess: @escaping @Sendable () async throws -> Void,
                     prepare: @escaping @Sendable (String, Bool) async throws -> JSONValue) async {
        var job = initial
        defer { work.removeValue(forKey: job.id) }
        do {
            try Task.checkCancellation()
            let id = try await provider.submit(job.request, settings: settings)
            try Task.checkCancellation()
            job.providerID = id
            job.status = "running"
            try save(job)
            let deadline = Date().addingTimeInterval(20 * 60)
            var assets: [Data]?
            while assets == nil && Date() < deadline {
                try await Task.sleep(for: .seconds(1))
                assets = try await provider.result(id)
            }
            try Task.checkCancellation()
            guard let assets, assets.count == job.request.count else {
                throw ImageRaster.invalid("Generation timed out or the provider returned an unexpected number of images.")
            }
            for (index, bytes) in assets.enumerated() {
                try await checkAccess()
                try Task.checkCancellation()
                let input = try ImageRaster.decode(bytes)
                guard input.image.width == job.request.width, input.image.height == job.request.height else {
                    throw ImageRaster.invalid("The generated image did not have the requested dimensions.")
                }
                let output = job.request.filename(index)
                let png = try ImageRaster.encoded(input.image, format: "png")
                try ImageWorkspaceFiles.export(root: directory, path: output, data: png)
                job.artifacts.append(output)
                try save(job)
                let document = try await prepare(output, job.request.show_in_workspace)
                job.documents.append(document)
                try Task.checkCancellation()
                try save(job)
            }
            job.status = "completed"
            try save(job)
        } catch {
            if Task.isCancelled {
                job.status = "canceled"
                job.error = "Lima stopped importing results. A submitted workflow may still finish in ComfyUI."
            } else {
                job.status = "failed"
                job.error = (error as? BridgeError)?.message ?? "Could not complete the local image job."
            }
            try? save(job)
        }
    }

    private func publicView(_ job: Job) -> JSONValue {
        let interrupted = ["queued", "running"].contains(job.status) && work[job.id] == nil
        return .object(["operation_id": .string(job.id), "provider_job_id": job.providerID.map(JSONValue.string) ?? .null,
                        "status": .string(interrupted ? "interrupted" : job.status),
                        "provider": .string("comfyui"), "model": .string(job.model), "prompt": .string(job.request.prompt),
                        "seed": .number(Double(job.request.seed)), "created_at": .number(job.createdAt.timeIntervalSince1970 * 1000),
                        "artifact_ids": .array(job.artifacts.map(JSONValue.string)), "documents": .array(job.documents),
                        "error": interrupted ? .string("Lima restarted before import finished. Check the provider job before resubmitting.") : job.error.map(JSONValue.string) ?? .null])
    }

    private func read(_ id: String, workspace: String) throws -> Job {
        guard id.utf8.count == 64, id.allSatisfy({ $0.isASCII && $0.isHexDigit }),
              let data = try? Data(contentsOf: root.appendingPathComponent(id + ".json")),
              let job = try? JSONDecoder().decode(Job.self, from: data), job.workspace == workspace else {
            throw BridgeError(.notAuthorized, "This image job is unavailable in the workspace.")
        }
        return job
    }

    private func save(_ job: Job) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(job).write(to: root.appendingPathComponent(job.id + ".json"), options: .atomic)
    }
}
