import AVFoundation
import Foundation
import LimaProtocol
@preconcurrency import Speech

/// Dictation, ported from Lima 4.x (NoteDictationService + LocalWhisperTranscriber):
/// record 16 kHz mono PCM, then transcribe on-device with the same
/// `whisper-cli` and model that 4.x shipped. Meeting dictation uses Apple's
/// network-capable Speech service when the user explicitly chooses it.
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
    private var meetingTitle: String?
    private var captureID = UUID()
    private var speech: NetworkSpeech?
    private var lastError: String?
    private var meter: DispatchSourceTimer?
    private var process: Process?
    var emit: (@Sendable (String, JSONValue) -> Void)?

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    // MARK: Engine discovery

    /// whisper-cli runs only from this app bundle and only when it is signed
    /// like lima-host: anything found in a user-writable folder would run with
    /// Lima's microphone permission. The model is data, so it may also come
    /// from the Lima 4 install the user already has.
    static func engine(environment: [String: String] = ProcessInfo.processInfo.environment) -> Engine? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var codeRoots: [URL] = []
        #if DEBUG
        if let dir = environment["LIMA_WHISPER_DIR"] { codeRoots.append(URL(fileURLWithPath: dir)) }
        #endif
        if let contents = CodeTrust.bundleContents {
            codeRoots.append(contents.appendingPathComponent("Resources/Whisper"))
        }
        let modelRoots = codeRoots + [
            home.appendingPathComponent("Library/Application Support/Lima Browser/Whisper"),
            home.appendingPathComponent("Library/Application Support/Lima/Whisper"),
            home.appendingPathComponent("Applications/Lima.app/Contents/Resources/Whisper"),
            URL(fileURLWithPath: "/Applications/Lima.app/Contents/Resources/Whisper"),
        ]
        let fm = FileManager.default
        let executable = codeRoots.map { $0.appendingPathComponent("runtime/whisper-cli") }.first {
            fm.isExecutableFile(atPath: $0.path) && CodeTrust.isSignedLikeSelf(path: $0.path)
        }
        let model = modelRoots.flatMap { [$0.appendingPathComponent("model/ggml-small.en-tdrz.bin"), $0.appendingPathComponent("model/ggml-small.en.bin")] }
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

    func start(target: String?, meeting: String? = nil) async throws {
        guard locked({ phase != .recording && phase != .transcribing }) else { return }
        if meeting != nil {
            let allowed = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
            guard allowed else {
                throw BridgeError(.notAuthorized, "Allow Speech Recognition for Lima in System Settings to use Apple dictation.")
            }
        } else if Self.engine() == nil {
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
        let id = UUID()
        try locked {
            guard phase != .recording && phase != .transcribing else { throw BridgeError(.badRequest, "Dictation is already running.") }
            guard recorder.record() else { throw BridgeError(.internalError, "The microphone couldn't start recording. Check the input device in System Settings → Sound.") }
            self.recorder = recorder
            self.target = target
            self.meetingTitle = meeting
            self.captureID = id
            self.phase = .recording
            self.lastError = nil
            self.startedAt = Date()
        }
        startMeter()
        publish()
        if meeting != nil {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(50))
                _ = try? await self?.stop(capture: id)
            }
        }
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
    func stop(capture: UUID? = nil) async throws -> String {
        let (url, target, meeting, id): (URL, String?, String?, UUID) = try locked {
            guard phase == .recording, let recorder, capture == nil || capture == captureID else {
                throw BridgeError(.badRequest, "not recording")
            }
            meter?.cancel(); meter = nil
            recorder.stop()
            self.recorder = nil
            phase = .transcribing
            return (recorder.url, self.target, self.meetingTitle, self.captureID)
        }
        publish()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let text: String
            if meeting != nil {
                let engine = NetworkSpeech()
                try locked {
                    guard captureID == id else { throw CancellationError() }
                    speech = engine
                }
                text = try await engine.transcribe(url)
            } else {
                text = try await transcribe(url)
            }
            let completed = locked {
                guard captureID == id, phase == .transcribing else { return false }
                phase = .idle
                speech = nil
                return true
            }
            guard completed else { throw CancellationError() }
            publish()
            emit?("dictation.result", .object(["text": .string(text), "target": target.map(JSONValue.string) ?? .null,
                                              "meeting": meeting.map(JSONValue.string) ?? .null]))
            return text
        } catch {
            if locked({ captureID == id && phase == .transcribing }) {
                locked { speech = nil }
                fail(String(describing: error))
            }
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
        speech?.cancel()
        speech = nil
        captureID = UUID()
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

private final class NetworkSpeech: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String, Error>?
    private var task: SFSpeechRecognitionTask?
    private var cancelled = false

    func transcribe(_ url: URL) async throws -> String {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            throw BridgeError(.badRequest, "Apple Speech Recognition is currently unavailable.")
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = false
        request.shouldReportPartialResults = false
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            guard !cancelled else {
                lock.unlock()
                continuation.resume(throwing: CancellationError())
                return
            }
            self.continuation = continuation
            lock.unlock()
            let recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
                if let error { self?.finish(.failure(error)) }
                else if let result, result.isFinal {
                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    self?.finish(text.isEmpty ? .failure(BridgeError(.badRequest, "No speech was recognized.")) : .success(text))
                }
            }
            lock.lock()
            let ongoing = self.continuation != nil
            if ongoing { task = recognition }
            lock.unlock()
            if !ongoing { recognition.cancel() }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(30))
                self?.finish(.failure(BridgeError(.deadlineExceeded, "Apple Speech Recognition timed out.")))
            }
        }
    }

    func cancel() { finish(.failure(CancellationError())) }

    private func finish(_ result: Result<String, Error>) {
        lock.lock()
        cancelled = true
        let waiter = continuation
        let recognition = task
        continuation = nil
        task = nil
        lock.unlock()
        if case .failure = result { recognition?.cancel() }
        waiter?.resume(with: result)
    }
}

extension Runtime {
    func registerDictation() {
        dictation.emit = { [weak self] event, data in self?.broadcast(event, data) }
        register("dictation.status") { [unowned self] _, _ in self.dictation.status }
        register("dictation.start") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the user can start dictation") }
            let meeting = params.optionalString("meeting").map { String($0.prefix(140)) }
            try await self.dictation.start(target: meeting == nil ? params.optionalString("target") : nil, meeting: meeting)
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
