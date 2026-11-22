import CoreGraphics
import Foundation
import ImageIO
import LimaProtocol
import UniformTypeIdentifiers

enum ImageRaster {
    static let maxPixels = 12_000_000
    static let maxFileBytes = 32 * 1024 * 1024
    private static let space = CGColorSpace(name: CGColorSpace.sRGB)!
    private static let rgba = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue

    struct Input {
        let image: CGImage
        let format: String
    }

    static func decode(_ data: Data) throws -> Input {
        guard data.count <= maxFileBytes,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String?,
              let format = [UTType.png.identifier: "png", UTType.jpeg.identifier: "jpeg", UTType.tiff.identifier: "tiff"][type],
              CGImageSourceGetCount(source) == 1,
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int,
              let height = props[kCGImagePropertyPixelHeight] as? Int else {
            throw invalid("Choose a single PNG, JPEG, or TIFF image within the file-size limit.")
        }
        try validate(width, height)
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height), kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw invalid("The image could not be decoded.")
        }
        return Input(image: image, format: format)
    }

    static func validate(_ width: Int, _ height: Int) throws {
        guard (1...8192).contains(width), (1...8192).contains(height), width * height <= maxPixels else {
            throw invalid("Image dimensions exceed the 8,192 pixel edge or 12 megapixel limit.")
        }
    }

    static func invalid(_ message: String) -> BridgeError { BridgeError(.badRequest, message) }

    static func integer(_ settings: JSONValue?, _ name: String) throws -> Int {
        guard let number = settings?[name]?.doubleValue, let value = Int(exactly: number) else {
            throw invalid("Provide a whole number for \(name).")
        }
        return value
    }

    private static func render(_ width: Int, _ height: Int, draw: (CGContext) -> Void) throws -> CGImage {
        try validate(width, height)
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: space, bitmapInfo: rgba) else {
            throw invalid("Could not allocate the image canvas.")
        }
        context.interpolationQuality = .high
        draw(context)
        guard let image = context.makeImage() else { throw invalid("Could not render the image.") }
        return image
    }

    static func resized(_ image: CGImage, width: Int, height: Int, mode: String) throws -> CGImage {
        try validate(width, height)
        let sx = Double(width) / Double(image.width), sy = Double(height) / Double(image.height)
        guard ["contain", "cover", "stretch", "pad"].contains(mode) else { throw invalid("Unknown resize mode.") }
        let scale = mode == "cover" ? max(sx, sy) : mode == "pad" ? min(1, sx, sy) : min(sx, sy)
        let drawn = mode == "stretch" ? CGSize(width: width, height: height)
            : CGSize(width: Double(image.width) * scale, height: Double(image.height) * scale)
        let rect = CGRect(x: (Double(width) - drawn.width) / 2, y: (Double(height) - drawn.height) / 2,
                          width: drawn.width, height: drawn.height)
        return try render(width, height) { $0.draw(image, in: rect) }
    }

    static func rotated(_ image: CGImage, degrees: Double) throws -> CGImage {
        guard degrees.isFinite, abs(degrees) <= 360 else { throw invalid("Rotation must be between −360 and 360 degrees.") }
        let radians = -degrees * .pi / 180
        let w = Double(image.width), h = Double(image.height)
        let c = abs(cos(radians)), s = abs(sin(radians))
        let width = Int(ceil(w * c + h * s - 1e-8)), height = Int(ceil(h * c + w * s - 1e-8))
        return try render(width, height) {
            $0.translateBy(x: Double(width) / 2, y: Double(height) / 2)
            $0.rotate(by: radians)
            $0.draw(image, in: CGRect(x: -w / 2, y: -h / 2, width: w, height: h))
        }
    }

    static func cropped(_ image: CGImage, parameters: JSONValue?, coordinates: String) throws -> CGImage {
        let x = parameters.double("x", default: -1), y = parameters.double("y", default: -1)
        let w = parameters.double("width", default: 0), h = parameters.double("height", default: 0)
        let normalized = coordinates == "normalized"
        let width = Double(image.width), height = Double(image.height)
        guard (normalized || coordinates == "pixels"), x >= 0, y >= 0, w > 0, h > 0,
              x + w <= (normalized ? 1 : width), y + h <= (normalized ? 1 : height) else {
            throw invalid("The crop rectangle must fit inside the image.")
        }
        let rect = normalized
            ? CGRect(x: x * width, y: y * height, width: w * width, height: h * height).integral
            : CGRect(x: x, y: y, width: w, height: h)
        guard (normalized || rect.integral == rect), let output = image.cropping(to: rect) else {
            throw invalid("Pixel crop coordinates must be whole numbers.")
        }
        return output
    }

    static func encoded(_ image: CGImage, format: String, quality: Double = 0.9) throws -> Data {
        guard let type = ["png": UTType.png, "jpeg": UTType.jpeg, "tiff": UTType.tiff][format],
              quality.isFinite, (0...1).contains(quality) else { throw invalid("Choose PNG, JPEG, or TIFF with a quality between 0 and 1.") }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else {
            throw invalid("The requested image format could not be initialized.")
        }
        let export = format == "jpeg" ? try render(image.width, image.height) {
            let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
            $0.setFillColor(gray: 1, alpha: 1)
            $0.fill(rect)
            $0.draw(image, in: rect)
        } : image
        CGImageDestinationAddImage(destination, export, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length <= maxFileBytes else {
            throw invalid("The encoded image exceeds the output size limit or could not be written.")
        }
        return output as Data
    }

    static func preview(_ image: CGImage) throws -> Data {
        let scale = min(1, 640.0 / Double(max(image.width, image.height)))
        if scale == 1 { return try encoded(image, format: "png") }
        return try encoded(resized(image, width: max(1, Int(Double(image.width) * scale)),
                                   height: max(1, Int(Double(image.height) * scale)), mode: "stretch"), format: "png")
    }

    private static func pixels(_ image: CGImage) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        try bytes.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                                          bitsPerComponent: 8, bytesPerRow: image.width * 4, space: space, bitmapInfo: rgba) else {
                throw invalid("Could not allocate the pixel buffer.")
            }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return bytes
    }

    static func hasTransparency(_ image: CGImage) throws -> Bool {
        if [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo) { return false }
        let bytes = try pixels(image)
        return stride(from: 3, to: bytes.count, by: 4).contains { bytes[$0] < 255 }
    }

    static func sample(_ image: CGImage, x: Int, y: Int) throws -> [Int] {
        guard (0..<image.width).contains(x), (0..<image.height).contains(y),
              let sample = image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)) else {
            throw invalid("The sample position is outside the image.")
        }
        let bytes = try pixels(sample)
        let alpha = Int(bytes[3])
        return bytes.prefix(3).map { alpha == 0 ? 0 : min(255, (Int($0) * 255 + alpha / 2) / alpha) } + [alpha]
    }

    static func masked(_ image: CGImage, by mask: CGImage, channel: String, invert: Bool) throws -> CGImage {
        guard image.width == mask.width, image.height == mask.height, ["luminance", "alpha"].contains(channel) else {
            throw invalid("Use an image-sized mask with luminance or alpha as its channel.")
        }
        let weights = try pixels(mask)
        var bytes = try pixels(image)
        for p in stride(from: 0, to: bytes.count, by: 4) {
            let weight = channel == "alpha" ? Int(weights[p + 3])
                : (54 * Int(weights[p]) + 183 * Int(weights[p + 1]) + 19 * Int(weights[p + 2]) + 128) / 256
            let keep = invert ? 255 - weight : weight
            for channel in 0..<4 { bytes[p + channel] = UInt8((Int(bytes[p + channel]) * keep + 127) / 255) }
        }
        return try imageFromRGBA(bytes, width: image.width, height: image.height)
    }

    static func trimmed(_ image: CGImage) throws -> CGImage {
        let bytes = try pixels(image)
        var left = image.width, right = -1, top = image.height, bottom = -1
        for y in 0..<image.height {
            for x in 0..<image.width where bytes[(y * image.width + x) * 4 + 3] > 0 {
                left = min(left, x); right = max(right, x)
                top = min(top, y); bottom = max(bottom, y)
            }
        }
        guard right >= left, bottom >= top,
              let output = image.cropping(to: CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)) else {
            throw invalid("The image is fully transparent.")
        }
        return output
    }

    private static let linear = (0...255).map { value -> Float in
        let c = Float(value) / 255
        return c <= 0.04045 ? c / 12.92 : powf((c + 0.055) / 1.055, 2.4)
    }

    private static func lab(_ r: Int, _ g: Int, _ b: Int) -> SIMD3<Float> {
        func pivot(_ value: Float) -> Float { value > 0.008856 ? cbrtf(value) : 7.787 * value + 16 / 116 }
        let r = linear[r], g = linear[g], b = linear[b]
        let x = pivot((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047)
        let y = pivot(0.2126729 * r + 0.7151522 * g + 0.0721750 * b)
        let z = pivot((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883)
        return SIMD3(116 * y - 16, 500 * (x - y), 200 * (y - z))
    }

    static func colorKey(_ image: CGImage, colors: [String], tolerance: Double, softness: Double,
                         connected: Bool, invert: Bool) throws -> CGImage {
        guard (1...4).contains(colors.count), (0...100).contains(tolerance), (0...50).contains(softness) else {
            throw invalid("Use one to four colors, tolerance 0–100, and softness 0–50.")
        }
        let keys = try colors.map { color -> SIMD3<Float> in
            guard color.count == 7, color.first == "#", let value = Int(color.dropFirst(), radix: 16), value >= 0 else {
                throw invalid("Use hex colors in #RRGGBB format.")
            }
            return lab(value >> 16, (value >> 8) & 255, value & 255)
        }
        let width = image.width, height = image.height, count = width * height
        var bytes = try pixels(image)
        var removal = [UInt8](repeating: 0, count: count)
        for i in 0..<count {
            let p = i * 4, alpha = Int(bytes[p + 3])
            if alpha == 0 { removal[i] = 255; continue }
            let color = lab(min(255, Int(bytes[p]) * 255 / alpha), min(255, Int(bytes[p + 1]) * 255 / alpha),
                            min(255, Int(bytes[p + 2]) * 255 / alpha))
            let distance = keys.reduce(Float.infinity) { nearest, key in
                let delta = color - key
                return min(nearest, delta.x * delta.x + delta.y * delta.y + delta.z * delta.z)
            }.squareRoot()
            let amount = distance <= Float(tolerance) ? 1 : max(0, 1 - (distance - Float(tolerance)) / Float(max(softness, 0.00001)))
            removal[i] = UInt8((amount * 255).rounded())
        }
        if connected {
            var reached = [UInt8](repeating: 0, count: count)
            var queue: [Int32] = []
            func visit(_ i: Int) {
                guard reached[i] == 0, removal[i] > 0 else { return }
                reached[i] = 1
                queue.append(Int32(i))
            }
            for x in 0..<width { visit(x); visit((height - 1) * width + x) }
            for y in 0..<height { visit(y * width); visit(y * width + width - 1) }
            var cursor = 0
            while cursor < queue.count {
                let i = Int(queue[cursor]), x = i % width
                cursor += 1
                if x > 0 { visit(i - 1) }
                if x + 1 < width { visit(i + 1) }
                if i >= width { visit(i - width) }
                if i + width < count { visit(i + width) }
            }
            for i in 0..<count where reached[i] == 0 { removal[i] = 0 }
        }
        for i in 0..<count {
            let keep = invert ? Int(removal[i]) : 255 - Int(removal[i])
            for channel in 0..<4 {
                let p = i * 4 + channel
                bytes[p] = UInt8((Int(bytes[p]) * keep + 127) / 255)
            }
        }
        return try imageFromRGBA(bytes, width: width, height: height)
    }

    private static func imageFromRGBA(_ bytes: [UInt8], width: Int, height: Int) throws -> CGImage {
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let output = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                                   space: space, bitmapInfo: CGBitmapInfo(rawValue: rgba), provider: provider,
                                   decode: nil, shouldInterpolate: true, intent: .defaultIntent) else {
            throw invalid("Could not render the edited transparency.")
        }
        return output
    }
}
