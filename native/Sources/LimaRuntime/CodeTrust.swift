import Darwin
import Foundation
import Security

/// Code-signature checks behind the runtime's trust boundaries.
///
/// Every process running as the user can reach the runtime socket, including
/// agent shells, so a client's claimed origin is not evidence. The `browser`
/// origin is granted only when the chain is verifiable:
///
///   Lima engine (`Contents/MacOS/lima`) → `lima-host --stdio` → daemon
///
/// A repacked build keeps the engine at `Contents/MacOS/zen`, behind the
/// `Contents/MacOS/lima` launcher; only that engine is trusted there.
///
/// The relay checks that its parent is the engine from its own bundle, and
/// the daemon checks that the peer is a lima-host signed like itself. A
/// hardened-runtime process can't have code injected by another process of
/// the same user, so the relay's word can be trusted once its signature is.
enum CodeTrust {
    // MARK: This process

    // Immutable Security objects, created once.
    nonisolated(unsafe) static let selfStaticCode: SecStaticCode? = {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess else { return nil }
        return staticCode
    }()

    nonisolated(unsafe) static let selfRequirement: SecRequirement? = {
        guard let selfStaticCode else { return nil }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(selfStaticCode, [], &requirement) == errSecSuccess else { return nil }
        return requirement
    }()

    static let selfLeafCertificate: Data? = selfStaticCode.flatMap(leafCertificate)

    /// Ad-hoc development builds carry no certificate; their designated
    /// requirement is a cdhash that changes on every rebuild.
    static var selfIsAdHoc: Bool { selfLeafCertificate == nil }

    static let selfExecutable: String = {
        let path = Bundle.main.executableURL?.path ?? CommandLine.arguments[0]
        return (path as NSString).resolvingSymlinksInPath
    }()

    /// `Lima.app/Contents` when lima-host runs from an app bundle.
    static var bundleContents: URL? {
        let macOS = URL(fileURLWithPath: selfExecutable).deletingLastPathComponent()
        guard macOS.lastPathComponent == "MacOS" else { return nil }
        return macOS.deletingLastPathComponent()
    }

    // MARK: Peers

    static func code(auditToken: Data) -> SecCode? {
        var code: SecCode?
        let attributes = [kSecGuestAttributeAudit: auditToken] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess else { return nil }
        return code
    }

    static func code(pid: pid_t) -> SecCode? {
        var code: SecCode?
        let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess else { return nil }
        return code
    }

    static func path(of code: SecCode) -> String? {
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var url: CFURL?
        guard SecCodeCopyPath(staticCode, [], &url) == errSecSuccess, let url else { return nil }
        return ((url as URL).path as NSString).resolvingSymlinksInPath
    }

    /// The running process is lima-host from this installation.
    static func isLimaHost(_ code: SecCode) -> Bool {
        if developmentOverride { return true }
        guard SecCodeCheckValidity(code, [], nil) == errSecSuccess else { return false }
        if !selfIsAdHoc, let selfRequirement {
            return SecCodeCheckValidity(code, [], selfRequirement) == errSecSuccess
        }
        return path(of: code) == selfExecutable
    }

    /// The running process is the browser engine of the bundle this
    /// lima-host belongs to, signed by the same certificate.
    static func isLimaEngine(_ code: SecCode) -> Bool {
        if developmentOverride { return true }
        guard let contents = bundleContents,
              SecCodeCheckValidity(code, [], nil) == errSecSuccess,
              path(of: code) == engineExecutable(in: contents)
        else { return false }
        if selfIsAdHoc { return true }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
        return leafCertificate(staticCode) == selfLeafCertificate
    }

    /// The Gecko executable of a bundle: the compiled `MacOS/lima`, or the
    /// repack's `MacOS/zen` when the bundle still carries one.
    static func engineExecutable(in contents: URL) -> String {
        let repacked = contents.appendingPathComponent("MacOS/zen")
        let engine = FileManager.default.fileExists(atPath: repacked.path)
            ? repacked : contents.appendingPathComponent("MacOS/lima")
        return (engine.path as NSString).resolvingSymlinksInPath
    }

    static func parentIsLimaEngine() -> Bool {
        let parent = getppid()
        guard parent > 1, let code = code(pid: parent) else { return developmentOverride }
        return isLimaEngine(code)
    }

    static func parentIsLimaHost() -> Bool {
        let parent = getppid()
        guard parent > 1, let code = code(pid: parent) else { return developmentOverride }
        return isLimaHost(code)
    }

    // MARK: Files

    /// A helper executable on disk is intact and signed like this lima-host.
    static func isSignedLikeSelf(path: String) -> Bool {
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &staticCode) == errSecSuccess, let staticCode else { return false }
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
        guard SecStaticCodeCheckValidity(staticCode, flags, nil) == errSecSuccess else { return false }
        return selfIsAdHoc || leafCertificate(staticCode) == selfLeafCertificate
    }

    static func leafCertificate(_ code: SecStaticCode) -> Data? {
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let certificates = (info as? [String: Any])?[kSecCodeInfoCertificates as String] as? [SecCertificate],
              let leaf = certificates.first
        else { return nil }
        return SecCertificateCopyData(leaf) as Data
    }

    /// Debug builds only: lets a developer run a daemon from `swift build`
    /// against a repacked browser. Compiled out of release builds.
    static var developmentOverride: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["LIMA_TRUST_ANY_PEER"] == "1"
        #else
        return false
        #endif
    }
}
