import Foundation

/// Installed application metadata for Search (spec v1 §3.3, "Applications
/// and commands"). Reads bundle names only.
public enum AppCatalog {
    public static let defaultRoots = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                                      NSHomeDirectory() + "/Applications", "/Applications/Utilities"]

    public static func scan(roots: [String] = defaultRoots) -> [SearchDocument] {
        var seen = Set<String>()
        var documents: [SearchDocument] = []
        let fileManager = FileManager.default
        for root in roots {
            guard let entries = try? fileManager.contentsOfDirectory(atPath: root) else { continue }
            for entry in entries where entry.hasSuffix(".app") {
                let path = (root as NSString).appendingPathComponent(entry)
                let name = String(entry.dropLast(4))
                guard seen.insert(name.lowercased()).inserted else { continue }
                let info = NSDictionary(contentsOfFile: path + "/Contents/Info.plist")
                let display = info?["CFBundleDisplayName"] as? String ?? name
                let bundleID = info?["CFBundleIdentifier"] as? String ?? ""
                documents.append(SearchDocument(
                    source: "app", id: path, title: display, body: "\(name) \(bundleID) application app",
                    subtitle: "Application", action: SearchAction("openApp", ["path": path])
                ))
            }
        }
        return documents
    }
}
