import AppKit
import CoreAudio
import Foundation
import LimaContext
import LimaProtocol
import Vision

// MARK: Audio devices (spec v2 §10)

struct AudioOutput: Codable, Sendable {
    var id: UInt32
    var name: String
    var isDefault: Bool
    var transport: String
}

enum AudioDevices {
    static func outputs() -> [AudioOutput] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        let current = defaultOutput()
        return ids.compactMap { id in
            guard outputChannels(id) > 0, let name = string(id, kAudioObjectPropertyName) else { return nil }
            return AudioOutput(id: id, name: name, isDefault: id == current, transport: transport(id))
        }
    }

    static func defaultOutput() -> AudioDeviceID {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
        return id
    }

    static func setDefaultOutput(_ id: UInt32) throws {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(id)
        let status = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &device)
        guard status == noErr else { throw BridgeError(.internalError, "could not switch output (\(status))") }
        var system = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &system, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &device)
    }

    static func volume() -> Float? {
        let device = defaultOutput()
        for element in [kAudioObjectPropertyElementMain, 1] {
            var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioDevicePropertyScopeOutput, mElement: element)
            var value: Float32 = 0
            var size = UInt32(MemoryLayout<Float32>.size)
            if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr { return value }
        }
        return nil
    }

    static func setVolume(_ value: Float) throws {
        let device = defaultOutput()
        var applied = false
        for element in [kAudioObjectPropertyElementMain, 1, 2] {
            var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioDevicePropertyScopeOutput, mElement: element)
            var settable: DarwinBoolean = false
            guard AudioObjectIsPropertySettable(device, &address, &settable) == noErr, settable.boolValue else { continue }
            var v = Float32(value)
            if AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &v) == noErr { applied = true }
            if element == kAudioObjectPropertyElementMain && applied { break }
        }
        guard applied else { throw BridgeError(.internalError, "this output device has no software volume") }
    }

    private static func outputChannels(_ id: AudioDeviceID) -> Int {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let list = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { list.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, list) == noErr else { return 0 }
        let buffers = UnsafeMutableAudioBufferListPointer(list.assumingMemoryBound(to: AudioBufferList.self))
        return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr else { return nil }
        return name?.takeRetainedValue() as String?
    }

    private static func transport(_ id: AudioObjectID) -> String {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
        switch value {
        case kAudioDeviceTransportTypeBuiltIn: return "built-in"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
        case kAudioDeviceTransportTypeUSB: return "usb"
        case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return "display"
        case kAudioDeviceTransportTypeAirPlay: return "airplay"
        case kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate: return "virtual"
        default: return "other"
        }
    }
}

// MARK: Now playing & controls

struct NowPlaying: Codable, Sendable {
    var player: String
    var title: String
    var artist: String
    var album: String
    var state: String
    var durationMs: Double?
    var updatedAt: Double
    /// Spotify artwork (https); Music has none to share by URL.
    var artworkURL: String?
    /// Playback position when the notification fired (or when queried).
    var positionMs: Double?
}

/// Spotify and Music post track metadata as distributed notifications; no
/// audio is captured and nothing beyond metadata is stored (spec v2 §8).
final class NowPlayingMonitor: @unchecked Sendable {
    private(set) var current: NowPlaying?
    private var lastRecordedKey: String?
    private let onChange: @Sendable (NowPlaying, Bool) -> Void

    init(onChange: @escaping @Sendable (NowPlaying, Bool) -> Void) {
        self.onChange = onChange
        let center = DistributedNotificationCenter.default()
        center.addObserver(forName: Notification.Name("com.spotify.client.PlaybackStateChanged"), object: nil, queue: .main) { [weak self] note in
            self?.update(player: "Spotify", info: note.userInfo ?? [:], durationScale: 1)
        }
        center.addObserver(forName: Notification.Name("com.apple.Music.playerInfo"), object: nil, queue: .main) { [weak self] note in
            self?.update(player: "Music", info: note.userInfo ?? [:], durationScale: 1)
        }
    }

    private func update(player: String, info: [AnyHashable: Any], durationScale: Double) {
        let item = NowPlaying(
            player: player,
            title: info["Name"] as? String ?? "",
            artist: info["Artist"] as? String ?? "",
            album: info["Album"] as? String ?? "",
            state: info["Player State"] as? String ?? "",
            durationMs: ((info["Duration"] as? NSNumber)?.doubleValue ?? (info["Total Time"] as? NSNumber)?.doubleValue).map { $0 * durationScale },
            updatedAt: Date().timeIntervalSince1970 * 1000,
            artworkURL: current?.player == player && current?.title == (info["Name"] as? String ?? "") ? current?.artworkURL : nil,
            positionMs: (info["Playback Position"] as? NSNumber).map { $0.doubleValue * 1000 }
        )
        current = item
        if player == "Spotify", item.artworkURL == nil, !item.title.isEmpty { fetchArtwork(for: item) }
        let key = "\(player)|\(item.title)|\(item.artist)"
        let isNewTrack = item.state == "Playing" && !item.title.isEmpty && key != lastRecordedKey
        if isNewTrack { lastRecordedKey = key }
        onChange(item, isNewTrack)
    }
}

extension NowPlayingMonitor {
    /// Spotify exposes the cover as a URL through AppleScript (the same
    /// Automation permission its playback controls use).
    func fetchArtwork(for item: NowPlaying) {
        DispatchQueue.global().async { [weak self] in
            guard let url = MediaControl.query("Spotify", "artwork url of current track"), url.hasPrefix("https://") else { return }
            DispatchQueue.main.async {
                guard let self, var current = self.current, current.title == item.title, current.player == item.player else { return }
                current.artworkURL = url
                self.replace(current)
            }
        }
    }

    func replace(_ item: NowPlaying) {
        current = item
        onChange(item, false)
    }

    /// Current state with a fresh playback position.
    func refreshed() -> NowPlaying? {
        guard var item = current else { return nil }
        if let seconds = MediaControl.query(item.player, "player position").flatMap(Double.init) {
            item.positionMs = seconds * 1000
            item.updatedAt = Date().timeIntervalSince1970 * 1000
        }
        return item
    }
}

enum MediaControl {
    /// One AppleScript property read from a running player (nil if it's not running).
    static func query(_ player: String, _ expression: String) -> String? {
        let bundle = player == "Spotify" ? "com.spotify.client" : "com.apple.Music"
        guard NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == bundle }) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", "tell application \"\(player)\" to \(expression)"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text.replacingOccurrences(of: ",", with: ".")
    }

    static func send(_ command: String) throws {
        let running = NSWorkspace.shared.runningApplications
        let target = running.contains { $0.bundleIdentifier == "com.spotify.client" } ? "Spotify" : "Music"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", "tell application \"\(target)\" to \(command)"]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw BridgeError(.notAuthorized, "Allow Lima to control \(target) in System Settings → Privacy & Security → Automation") }
    }

    /// Spotify has no public DJ API; open the DJ entry in Spotify itself.
    static func openDJ() {
        NSWorkspace.shared.open(URL(string: "spotify:playlist:37i9dQZF1EYkqdzj48dyYq")!)
    }
}

// MARK: Screenshot capture & OCR (spec v2 §9)

struct CaptureRecord: Codable, Sendable {
    var id: String
    var createdAt: Double
    var width: Int
    var height: Int
    var pngBase64: String
}

struct OCRLine: Codable, Sendable {
    var text: String
    var confidence: Float
    /// Pixel rectangle in the captured image's coordinate space (origin top-left).
    var x: Double, y: Double, width: Double, height: Double
}

/// Captures go to an in-memory Studio tray. They are never written to
/// context history; saving to Notes stores them as encrypted attachments.
actor CaptureService {
    static let shared = CaptureService()
    enum Mode { case region, window, display(Int) }

    private var tray: [CaptureRecord] = []

    func capture(_ mode: Mode) async throws -> CaptureRecord {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("lima-capture-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        // screencapture handles multi-display layouts, Retina scale, Spaces
        // and window picking natively.
        var arguments = ["-x", "-t", "png"]
        switch mode {
        case .region: arguments += ["-i", "-s"]
        case .window: arguments += ["-i", "-w", "-o"]
        case .display(let number): arguments += ["-D", String(max(1, number))]
        }
        arguments.append(file.path)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = arguments
        try process.run()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in continuation.resume() }
        }
        guard let data = try? Data(contentsOf: file), let image = NSImage(data: data),
              let rep = image.representations.first else {
            throw BridgeError(.badRequest, "Capture cancelled. If nothing was captured, allow Screen Recording for Lima in System Settings.")
        }
        let record = CaptureRecord(id: UUID().uuidString, createdAt: Date().timeIntervalSince1970 * 1000,
                                   width: rep.pixelsWide, height: rep.pixelsHigh, pngBase64: data.base64EncodedString())
        tray.insert(record, at: 0)
        if tray.count > 20 { tray.removeLast() }
        return record
    }

    func list() -> [CaptureRecord] { tray }

    func get(_ id: String) -> CaptureRecord? { tray.first { $0.id == id } }

    func discard(_ id: String) { tray.removeAll { $0.id == id } }

    /// Vision OCR; boxes converted from Vision's normalized bottom-left
    /// space to image pixels with a top-left origin.
    static func recognize(png: Data) throws -> [OCRLine] {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw BridgeError(.badRequest, "invalid image") }
        let width = Double(image.width), height = Double(image.height)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return OCRLine(text: candidate.string, confidence: candidate.confidence,
                           x: box.minX * width, y: (1 - box.maxY) * height, width: box.width * width, height: box.height * height)
        }
    }
}

extension Runtime {
    func registerMedia() {
        register("audio.outputs") { _, _ in try JSONValue.from(AudioDevices.outputs()) }
        register("audio.setOutput") { params, _ in
            try AudioDevices.setDefaultOutput(UInt32(params.int("id", default: 0)))
            return try JSONValue.from(AudioDevices.outputs())
        }
        register("audio.volume") { params, _ in
            if let value = params?["value"]?.doubleValue { try AudioDevices.setVolume(Float(min(max(value, 0), 1))) }
            return .number(Double(AudioDevices.volume() ?? 0))
        }
        register("media.nowPlaying") { [unowned self] _, _ in
            (try? JSONValue.from(self.activity?.nowPlaying.refreshed())) ?? .null
        }
        register("media.control") { params, _ in
            let action = try params.string("action")
            switch action {
            case "playpause": try MediaControl.send("playpause")
            case "next": try MediaControl.send("next track")
            case "previous": try MediaControl.send("previous track")
            case "dj": MediaControl.openDJ()
            default: throw BridgeError(.badRequest, "unknown media action")
            }
            return .null
        }
        register("capture.take") { params, _ in
            let mode: CaptureService.Mode
            switch params.optionalString("mode") ?? "region" {
            case "window": mode = .window
            case "display": mode = .display(params.int("display", default: 1))
            default: mode = .region
            }
            return try JSONValue.from(try await CaptureService.shared.capture(mode))
        }
        register("capture.list") { _, _ in try JSONValue.from(await CaptureService.shared.list()) }
        register("capture.discard") { params, _ in await CaptureService.shared.discard(try params.string("id")); return .null }
        register("capture.ocr") { params, _ in
            let png: Data
            if let id = params.optionalString("id") {
                guard let record = await CaptureService.shared.get(id), let data = Data(base64Encoded: record.pngBase64) else { throw BridgeError(.badRequest, "capture not found") }
                png = data
            } else {
                guard let data = Data(base64Encoded: try params.string("png")) else { throw BridgeError(.badRequest, "png must be base64") }
                png = data
            }
            return try JSONValue.from(try CaptureService.recognize(png: png))
        }
    }
}

// MARK: Activity recorders (spec v2 §8)

/// Records frontmost-application changes and music metadata. Runs only in
/// the daemon; never reads window contents or keystrokes.
final class ActivityRecorder: @unchecked Sendable {
    let nowPlaying: NowPlayingMonitor
    private weak var runtime: Runtime?

    init(runtime: Runtime) {
        self.runtime = runtime
        self.nowPlaying = NowPlayingMonitor { [weak runtime] item, isNewTrack in
            runtime?.broadcast("media.nowPlaying", (try? JSONValue.from(item)) ?? .null)
            guard isNewTrack else { return }
            runtime?.recordActivity(ActivityEvent(kind: .media, title: item.title, detail: item.artist, app: item.player,
                                                  durationMs: item.durationMs, metadata: ["album": item.album, "player": item.player]))
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.runtime?.recordActivity(ActivityEvent(kind: .app, title: app.localizedName ?? app.bundleIdentifier ?? "App",
                                                        app: app.bundleIdentifier, metadata: ["bundleID": app.bundleIdentifier ?? ""]))
        }
    }
}
