import AVFoundation
import Foundation
import LimaProtocol

/// Dictation, ported from Lima 4.x (NoteDictationService + LocalWhisperTranscriber):
/// record 16 kHz mono PCM, then transcribe on-device with the same
/// `whisper-cli` and `ggml-small.en(-tdrz)` model 4.x shipped. Nothing leaves
/// the Mac. The browser decides where the text goes (the focused note, or a
/// new Dictation note), as in 4.x where dictation landed in Notes.
final class DictationService: NSObject, @unchecked Sendable, AVAudioRecorderDelegate {
    enum Phase: String, Sendable { case idle, recording, transcribing, failed }

    struct Engine: Sendable {
        let executable: URL
        let model: URL
    }

    private let lock = NSLock()
    private var phase: Phase = .idle
    private var recorder: AVAudioRecorder?
    private var startedAt = Date()
    private var target: String?
    private var lastError: String?
    private var meter: DispatchSourceTimer?
    private var process: Process?
    var emit: (@Sendable (String, JSONValue) -> Void)?

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    // MARK: Engine discovery

    static func engine(environment: [String: String] = ProcessInfo.processInfo.environment) -> Engine? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var roots: [URL] = []
        if let dir = environment["LIMA_WHISPER_DIR"] { roots.append(URL(fileURLWithPath: dir)) }
        if let exe = Bundle.main.executableURL?.resolvingSymlinksInPath() {
            roots.append(exe.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/Whisper"))
        }
        roots += [
            home.appendingPathComponent("Library/Application Support/Lima Browser/Whisper"),
            home.appendingPathComponent("Library/Application Support/Lima/Whisper"),
            home.appendingPathComponent("Applications/Lima.app/Contents/Resources/Whisper"),
            URL(fileURLWithPath: "/Applications/Lima.app/Contents/Resources/Whisper"),
        ]
        let fm = FileManager.default
        let executable = roots.map { $0.appendingPathComponent("runtime/whisper-cli") }.first { fm.isExecutableFile(atPath: $0.path) }
        let model = roots.flatMap { [$0.appendingPathComponent("model/ggml-small.en-tdrz.bin"), $0.appendingPathComponent("model/ggml-small.en.bin")] }
            .first { fm.fileExists(atPath: $0.path) }
        guard let executable, let model else { return nil }
        return Engine(executable: executable, model: model)
    }

    // MARK: State

    var status: JSONValue {
        lock.lock(); defer { lock.unlock() }
        return statusLocked(level: 0)
    }

    private func statusLocked(level: Float) -> JSONValue {
        .object([
            "phase": .string(phase.rawValue),
            "elapsedMs": .number(phase == .recording ? Date().timeIntervalSince(startedAt) * 1000 : 0),
            "level": .number(Double(level)),
            "target": target.map(JSONValue.string) ?? .null,
            "error": lastError.map(JSONValue.string) ?? .null,
            "engine": .bool(Self.engine() != nil),
        ])
    }

    private func publish(level: Float = 0) {
        lock.lock(); let state = statusLocked(level: level); lock.unlock()
        emit?("dictation.state", state)
    }

    private func fail(_ message: String) {
        lock.lock(); phase = .failed; lastError = message; recorder = nil; lock.unlock()
        publish()
    }

    // MARK: Recording

    func start(target: String?) async throws {
        guard locked({ phase != .recording && phase != .transcribing }) else { return }
        guard Self.engine() != nil else {
            throw BridgeError(.badRequest, "On-device transcription isn't installed. Lima uses the Whisper engine from Lima 4 (~/Applications/Lima.app) or ~/Library/Application Support/Lima Browser/Whisper.")
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw Self.permissionError }
        default: throw Self.permissionError
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("lima-dictation-\(UUID().uuidString).wav")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
                                       AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.isMeteringEnabled = true
        recorder.delegate = self
        guard recorder.record() else { throw BridgeError(.internalError, "The microphone couldn't start recording. Check the input device in System Settings → Sound.") }
        locked {
            self.recorder = recorder
            self.target = target
            self.phase = .recording
            self.lastError = nil
            self.startedAt = Date()
        }
        startMeter()
        publish()
    }

    private static var permissionError: BridgeError {
        BridgeError(.notAuthorized, "Allow microphone access for Lima in System Settings → Privacy & Security → Microphone, then try again.")
    }

    private func startMeter() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock(); let recorder = self.recorder; self.lock.unlock()
            guard let recorder else { return }
            recorder.updateMeters()
            // Same normalization as 4.x: -50 dB floor, -5 dB ceiling.
            let db = Double(recorder.averagePower(forChannel: 0))
            self.publish(level: Float(max(0, min(1, (db + 50) / 45))))
        }
        timer.resume()
        lock.lock(); meter?.cancel(); meter = timer; lock.unlock()
    }

    /// Stops recording and transcribes. Returns the text (also broadcast as
    /// `dictation.result` with the target chosen at start).
    func stop() async throws -> String {
        let (url, target): (URL, String?) = try locked {
            guard phase == .recording, let recorder else { throw BridgeError(.badRequest, "not recording") }
            meter?.cancel(); meter = nil
            recorder.stop()
            self.recorder = nil
            phase = .transcribing
            return (recorder.url, self.target)
        }
        publish()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let text = try await transcribe(url)
            locked { phase = .idle }
            publish()
            emit?("dictation.result", .object(["text": .string(text), "target": target.map(JSONValue.string) ?? .null]))
            return text
        } catch {
            fail(String(describing: error))
            throw error
        }
    }

    func cancel() {
        lock.lock()
        meter?.cancel(); meter = nil
        let url = recorder?.url
        recorder?.stop()
        recorder = nil
        process?.terminate()
        phase = .idle
        lastError = nil
        lock.unlock()
        if let url { try? FileManager.default.removeItem(at: url) }
        publish()
    }

    // MARK: Transcription

    func transcribe(_ audio: URL) async throws -> String {
        guard let engine = Self.engine() else { throw BridgeError(.badRequest, "On-device transcription isn't installed") }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("lima-whisper-\(UUID().uuidString)")
        let process = Process()
        process.executableURL = engine.executable
        process.arguments = ["-m", engine.model.path, "-f", audio.path, "-l", "en", "-t", String(min(8, max(2, ProcessInfo.processInfo.activeProcessorCount - 2))),
                             "-nt", "-np", "--output-txt", "--output-file", output.path]
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe()
        process.standardError = errors
        locked { self.process = process }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            process.terminationHandler = { _ in continuation.resume() }
            do { try process.run() } catch {
                process.terminationHandler = nil
                continuation.resume(throwing: error)
            }
        }
        locked { self.process = nil }
        let txt = output.appendingPathExtension("txt")
        defer { try? FileManager.default.removeItem(at: txt) }
        guard process.terminationStatus == 0, let raw = try? String(contentsOf: txt, encoding: .utf8) else {
            let detail = String(decoding: errors.fileHandleForReading.readDataToEndOfFile().suffix(400), as: UTF8.self)
            throw BridgeError(.internalError, "Transcription failed\(detail.isEmpty ? "" : ": \(detail)")")
        }
        let text = Self.clean(raw)
        guard !text.isEmpty else { throw BridgeError(.badRequest, "No speech was recognized in the recording.") }
        return text
    }

    /// Whisper markers ([BLANK_AUDIO], [SPEAKER_TURN], (music)…) aren't words.
    static func clean(_ raw: String) -> String {
        raw.replacingOccurrences(of: #"\[[A-Z_ ]+\]|\((?:music|applause|silence|inaudible)\)"#, with: " ", options: [.regularExpression, .caseInsensitive])
            .split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .joined(separator: " ")
            .replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        fail("Recording failed: \(error.map(String.init(describing:)) ?? "encoder error")")
    }
}

extension Runtime {
    func registerDictation() {
        dictation.emit = { [weak self] event, data in self?.broadcast(event, data) }
        register("dictation.status") { [unowned self] _, _ in self.dictation.status }
        register("dictation.start") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the user can start dictation") }
            try await self.dictation.start(target: params.optionalString("target"))
            return self.dictation.status
        }
        register("dictation.stop") { [unowned self] _, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the user can stop dictation") }
            return .object(["text": .string(try await self.dictation.stop())])
        }
        register("dictation.cancel") { [unowned self] _, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the user can cancel dictation") }
            self.dictation.cancel()
            return self.dictation.status
        }
        /// Transcribe an existing recording (diagnostics and tests).
        register("dictation.transcribeFile") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "browser only") }
            return .object(["text": .string(try await self.dictation.transcribe(URL(fileURLWithPath: try params.string("path"))))])
        }
    }
}
