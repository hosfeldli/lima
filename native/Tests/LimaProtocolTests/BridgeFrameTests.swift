import Foundation
import Testing
@testable import LimaProtocol

@Test func framesRoundTripAcrossArbitraryChunkBoundaries() throws {
    let first = Data(#"{"a":1}"#.utf8)
    let second = Data(#"{"b":"two"}"#.utf8)
    let stream = BridgeFrame.encode(first) + BridgeFrame.encode(second)
    var decoder = BridgeFrame.Decoder()
    var received: [Data] = []
    for byte in stream { received += try decoder.append(Data([byte])) }
    #expect(received == [first, second])
}

@Test func oversizedFrameIsRejected() {
    var decoder = BridgeFrame.Decoder()
    var length = UInt32(BridgeFrame.maximumPayloadBytes + 1).littleEndian
    let header = Data(bytes: &length, count: 4)
    #expect(throws: BridgeFrame.DecodeError.self) { try decoder.append(header) }
}

@Test func requestEnvelopeCarriesProtocolVersion() throws {
    let request = BridgeRequest(id: "1", method: "host.ping")
    let decoded = try JSONDecoder().decode(BridgeRequest.self, from: JSONEncoder().encode(request))
    #expect(decoded.v == limaBridgeProtocolVersion)
    #expect(decoded == request)
}
