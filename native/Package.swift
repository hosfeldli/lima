// swift-tools-version: 6.0

import PackageDescription

// Lima 5.0 native runtime. Every target communicates through LimaProtocol
// types rather than another target's internal state (spec §13).
let package = Package(
    name: "LimaNative",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "lima-host", targets: ["LimaHost"]),
        .library(name: "LimaRuntime", targets: ["LimaRuntime"])
    ],
    targets: [
        .target(name: "LimaProtocol"),
        .target(name: "LimaAuthorization", dependencies: ["LimaProtocol"]),
        .target(name: "CLimaPTY"),
        .target(name: "LimaTerminal", dependencies: ["LimaProtocol", "CLimaPTY"]),
        .target(name: "LimaStorage"),
        .target(name: "LimaAgentSupervisor", dependencies: ["LimaProtocol", "LimaStorage"]),
        .target(name: "LimaNotes", dependencies: ["LimaStorage"]),
        .target(name: "LimaSearch"),
        .target(name: "LimaContext", dependencies: ["LimaStorage"]),
        .target(
            name: "LimaRuntime",
            dependencies: ["LimaProtocol", "LimaAuthorization", "LimaTerminal", "LimaStorage", "LimaAgentSupervisor",
                           "LimaNotes", "LimaSearch", "LimaContext"],
            resources: [.copy("Resources/emoji-test.txt")]
        ),
        .executableTarget(
            name: "LimaHost",
            dependencies: ["LimaRuntime", "LimaProtocol", "LimaAgentSupervisor", "LimaAuthorization"],
            exclude: ["Support"],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                                           "-Xlinker", Context.packageDirectory + "/Sources/LimaHost/Support/Info.plist"])]
        ),
        .testTarget(name: "LimaProtocolTests", dependencies: ["LimaProtocol"]),
        .testTarget(name: "LimaAuthorizationTests", dependencies: ["LimaAuthorization"]),
        .testTarget(name: "LimaTerminalTests", dependencies: ["LimaTerminal"]),
        .testTarget(name: "LimaAgentSupervisorTests", dependencies: ["LimaAgentSupervisor", "LimaStorage"]),
        .testTarget(name: "LimaStorageTests", dependencies: ["LimaStorage"]),
        .testTarget(name: "LimaNotesTests", dependencies: ["LimaNotes", "LimaStorage"]),
        .testTarget(name: "LimaSearchTests", dependencies: ["LimaSearch", "LimaContext", "LimaStorage"]),
        .testTarget(name: "LimaRuntimeTests", dependencies: ["LimaRuntime", "LimaProtocol"])
    ],
    swiftLanguageModes: [.v6]
)
