// swift-tools-version: 6.0

import PackageDescription

// Lima 5.0 native runtime.
//
// Services land here one at a time as they are migrated out of
// legacy/lima-4 (see docs/architecture/migration-map.md). Every target
// communicates through LimaProtocol types rather than another target's
// internal state (spec §13).
let package = Package(
    name: "LimaNative",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "lima-host", targets: ["LimaHost"]),
        .library(name: "LimaProtocol", targets: ["LimaProtocol"]),
        .library(name: "LimaAuthorization", targets: ["LimaAuthorization"]),
        .library(name: "LimaTerminal", targets: ["LimaTerminal"]),
        .library(name: "LimaAgentSupervisor", targets: ["LimaAgentSupervisor"])
    ],
    targets: [
        .target(name: "LimaProtocol"),
        .target(name: "LimaAuthorization", dependencies: ["LimaProtocol"]),
        .target(name: "LimaTerminal", dependencies: ["LimaProtocol"]),
        .target(name: "LimaAgentSupervisor", dependencies: ["LimaProtocol"]),
        .target(name: "LimaStorage"),
        .target(name: "LimaNotes", dependencies: ["LimaStorage"]),
        .executableTarget(
            name: "LimaHost",
            dependencies: ["LimaProtocol", "LimaAuthorization", "LimaTerminal", "LimaAgentSupervisor"]
        ),
        .testTarget(name: "LimaProtocolTests", dependencies: ["LimaProtocol"]),
        .testTarget(name: "LimaAuthorizationTests", dependencies: ["LimaAuthorization"]),
        .testTarget(name: "LimaTerminalTests", dependencies: ["LimaTerminal"]),
        .testTarget(name: "LimaAgentSupervisorTests", dependencies: ["LimaAgentSupervisor"]),
        .testTarget(name: "LimaStorageTests", dependencies: ["LimaStorage"]),
        .testTarget(name: "LimaNotesTests", dependencies: ["LimaNotes", "LimaStorage"])
    ],
    swiftLanguageModes: [.v6]
)
