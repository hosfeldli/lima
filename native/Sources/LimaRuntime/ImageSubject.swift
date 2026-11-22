import CoreGraphics
import CoreVideo
import Foundation
import LimaProtocol
import Vision

enum ImageSubject {
    struct Selection {
        let mask: CGImage
        let instances: [Int]
    }

    static func select(_ image: CGImage, requested: [Int]?) throws -> Selection {
        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
        do {
            try handler.perform([request])
        } catch {
            throw ImageRaster.invalid("Apple Vision could not analyze this image on this Mac.")
        }
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
            throw ImageRaster.invalid("No foreground subject was detected. Try color keying or import a mask.")
        }
        if let requested, (requested.isEmpty || requested.count > 256 || requested.contains(where: { $0 <= 0 || !observation.allInstances.contains($0) })) {
            throw ImageRaster.invalid("Choose foreground instance IDs returned for this image revision.")
        }
        let ids = requested.map { IndexSet($0) } ?? observation.allInstances
        let buffer = try observation.generateScaledMaskForImage(forInstances: ids, from: handler)
        return Selection(mask: try imageMask(buffer, width: image.width, height: image.height), instances: Array(ids))
    }

    private static func imageMask(_ buffer: CVPixelBuffer, width: Int, height: Int) throws -> CGImage {
        let flags = CVPixelBufferLockFlags.readOnly
        guard CVPixelBufferLockBaseAddress(buffer, flags) == kCVReturnSuccess else {
            throw ImageRaster.invalid("The foreground mask is unavailable.")
        }
        defer { CVPixelBufferUnlockBaseAddress(buffer, flags) }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let format = CVPixelBufferGetPixelFormatType(buffer)
        guard let address = CVPixelBufferGetBaseAddress(buffer),
              CVPixelBufferGetWidth(buffer) == width, CVPixelBufferGetHeight(buffer) == height,
              [kCVPixelFormatType_OneComponent8, kCVPixelFormatType_OneComponent32Float, kCVPixelFormatType_OneComponent16Half].contains(format) else {
            throw ImageRaster.invalid("Vision returned an unsupported mask format.")
        }
        var pixels = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            let row = address.advanced(by: y * rowBytes)
            for x in 0..<width {
                let value: Float
                switch format {
                case kCVPixelFormatType_OneComponent8: value = Float(row.load(fromByteOffset: x, as: UInt8.self)) / 255
                case kCVPixelFormatType_OneComponent16Half:
                    value = Float(Float16(bitPattern: row.loadUnaligned(fromByteOffset: x * 2, as: UInt16.self)))
                default: value = row.loadUnaligned(fromByteOffset: x * 4, as: Float.self)
                }
                pixels[y * width + x] = value.isFinite ? UInt8((min(1, max(0, value)) * 255).rounded()) : 0
            }
        }
        guard let source = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                                  provider: source, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw ImageRaster.invalid("The foreground mask could not be decoded.")
        }
        return image
    }
}
