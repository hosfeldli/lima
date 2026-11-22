import CoreGraphics
import Foundation
import LimaProtocol

struct StudioVector: Codable, Sendable {
    struct Segment: Codable, Sendable {
        var command: String
        var points: [Double]
    }

    struct Shape: Codable, Sendable {
        var id: String
        var segments: [Segment]
        var fill: String
        var stroke: String = "none"
        var strokeWidth: Double = 1
        var opacity: Double = 1
        var matrix: [Double] = [1, 0, 0, 1, 0, 0]
        var group: String? = nil
        var evenOdd = true
    }

    var width: Int
    var height: Int
    var viewBox: [Double]
    var shapes: [Shape]

    static let maxShapes = 1200
    static let maxSegments = 80_000
    private static let pathToken = try! NSRegularExpression(pattern: "[A-Za-z]|[-+]?(?:[0-9]*\\.[0-9]+|[0-9]+\\.?[0-9]*)(?:[eE][-+]?[0-9]+)?")

    static func parsePath(_ value: String) throws -> [Segment] {
        guard value.utf8.count <= 1_500_000 else { throw ImageRaster.invalid("The path is too large.") }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        let rest = pathToken.stringByReplacingMatches(in: value, range: range, withTemplate: "")
        guard rest.allSatisfy({ $0 == "," || $0.isWhitespace }) else { throw ImageRaster.invalid("Invalid SVG path data.") }
        let tokens = pathToken.matches(in: value, range: range).compactMap { match in
            Range(match.range, in: value).map { String(value[$0]) }
        }
        var index = 0, command = ""
        var cursor = CGPoint.zero, start = CGPoint.zero
        var output: [Segment] = []
        let arity = ["M": 2, "L": 2, "H": 1, "V": 1, "Q": 4, "C": 6, "Z": 0]
        while index < tokens.count {
            if Double(tokens[index]) == nil { command = tokens[index]; index += 1 }
            let upper = command.uppercased(), relative = command != upper
            guard let length = arity[upper], index + length <= tokens.count else {
                throw ImageRaster.invalid("Supported paths use M, L, H, V, Q, C, and Z commands.")
            }
            if upper == "Z" {
                output.append(Segment(command: "Z", points: []))
                cursor = start
                command = ""
                continue
            }
            var points = tokens[index..<(index + length)].compactMap { Double($0) }
            guard points.count == length, points.allSatisfy(bounded) else { throw ImageRaster.invalid("Invalid path coordinates.") }
            index += length
            if upper == "H" { points = [points[0] + (relative ? cursor.x : 0), cursor.y] }
            else if upper == "V" { points = [cursor.x, points[0] + (relative ? cursor.y : 0)] }
            else if relative {
                for position in points.indices {
                    points[position] += position.isMultiple(of: 2) ? cursor.x : cursor.y
                }
            }
            cursor = CGPoint(x: points[length == 1 ? 0 : length - 2], y: points[length == 1 ? 1 : length - 1])
            output.append(Segment(command: upper == "H" || upper == "V" ? "L" : upper, points: points))
            if upper == "M" { start = cursor; command = relative ? "l" : "L" }
        }
        try validateSegments(output)
        return output
    }

    static func validateSegments(_ segments: [Segment]) throws {
        let arity = ["M": 2, "L": 2, "Q": 4, "C": 6, "Z": 0]
        guard !segments.isEmpty, segments.count <= maxSegments, segments.first?.command == "M",
              segments.allSatisfy({ arity[$0.command] == $0.points.count && $0.points.allSatisfy(bounded) }) else {
            throw ImageRaster.invalid("Invalid or unsupported path geometry.")
        }
    }

    static func bounded(_ value: Double) -> Bool { value.isFinite && abs(value) <= 100_000 }

    static func paint(_ color: String) throws -> String {
        let lower = color.lowercased()
        if ["none", "black", "white", "transparent"].contains(lower) {
            return ["black": "#000000", "white": "#ffffff", "transparent": "none"][lower] ?? lower
        }
        let expanded = lower.count == 4 && lower.first == "#" ? "#" + lower.dropFirst().map { String(repeating: String($0), count: 2) }.joined() : lower
        guard expanded.count == 7, expanded.first == "#", expanded.dropFirst().allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
            throw ImageRaster.invalid("Use a solid hex color or none.")
        }
        return expanded
    }

    static func transform(_ values: [Double]) -> CGAffineTransform {
        CGAffineTransform(a: values[0], b: values[1], c: values[2], d: values[3], tx: values[4], ty: values[5])
    }

    static func matrix(_ transform: CGAffineTransform) -> [Double] {
        [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty]
    }

    func validate() throws {
        try ImageRaster.validate(width, height)
        guard viewBox.count == 4, viewBox.allSatisfy(Self.bounded), viewBox[2] > 0, viewBox[3] > 0,
              !shapes.isEmpty, shapes.count <= Self.maxShapes,
              Set(shapes.map(\.id)).count == shapes.count, shapes.reduce(0, { $0 + $1.segments.count }) <= Self.maxSegments else {
            throw ImageRaster.invalid("The SVG has invalid dimensions, duplicate IDs, or too much geometry.")
        }
        for shape in shapes {
            try Self.validateSegments(shape.segments)
            _ = try Self.paint(shape.fill)
            _ = try Self.paint(shape.stroke)
            guard shape.matrix.count == 6, shape.matrix.allSatisfy(Self.bounded), Self.bounded(shape.strokeWidth), shape.strokeWidth >= 0,
                  (0...1).contains(shape.opacity) else { throw ImageRaster.invalid("Invalid SVG style or transform.") }
        }
    }

    func svg() throws -> Data {
        try validate()
        func number(_ value: Double) -> String { value == 0 ? "0" : String(format: "%.9g", locale: Locale(identifier: "en_US_POSIX"), value) }
        func numbers(_ values: [Double]) -> String { values.map(number).joined(separator: " ") }
        func escaped(_ string: String) -> String {
            string.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
        }
        var xml = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(width)\" height=\"\(height)\" viewBox=\"\(numbers(viewBox))\">\n"
        var group: String?
        var groupCount = 0
        for shape in shapes {
            if shape.group != group {
                if group != nil { xml += "</g>\n" }
                group = shape.group
                if let group {
                    groupCount += 1
                    xml += "<g id=\"layer-\(groupCount)\" data-group=\"\(escaped(group))\">\n"
                }
            }
            let d = shape.segments.map { $0.command + numbers($0.points) }.joined(separator: " ")
            xml += "<path id=\"\(escaped(shape.id))\" d=\"\(d)\" fill=\"\(shape.fill)\" fill-rule=\"\(shape.evenOdd ? "evenodd" : "nonzero")\" stroke=\"\(shape.stroke)\" stroke-width=\"\(number(shape.strokeWidth))\" opacity=\"\(number(shape.opacity))\" transform=\"matrix(\(numbers(shape.matrix)))\"/>\n"
        }
        if group != nil { xml += "</g>\n" }
        return Data((xml + "</svg>\n").utf8)
    }

    func raster(maxEdge: Int = 640) throws -> CGImage {
        try validate()
        let scale = min(1, Double(maxEdge) / Double(max(width, height)))
        let w = max(1, Int(Double(width) * scale)), h = max(1, Int(Double(height) * scale))
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw ImageRaster.invalid("Could not allocate the SVG preview.")
        }
        let fit = min(Double(w) / viewBox[2], Double(h) / viewBox[3])
        context.translateBy(x: (Double(w) - fit * viewBox[2]) / 2, y: (Double(h) + fit * viewBox[3]) / 2)
        context.scaleBy(x: fit, y: -fit)
        context.translateBy(x: -viewBox[0], y: -viewBox[1])
        func color(_ hex: String) -> CGColor? {
            guard let value = Int(hex.dropFirst(), radix: 16) else { return nil }
            return CGColor(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, alpha: 1)
        }
        for shape in shapes {
            context.saveGState()
            context.concatenate(Self.transform(shape.matrix))
            context.setAlpha(shape.opacity)
            let path = CGMutablePath()
            for segment in shape.segments {
                let p = segment.points
                switch segment.command {
                case "M": path.move(to: CGPoint(x: p[0], y: p[1]))
                case "L": path.addLine(to: CGPoint(x: p[0], y: p[1]))
                case "Q": path.addQuadCurve(to: CGPoint(x: p[2], y: p[3]), control: CGPoint(x: p[0], y: p[1]))
                case "C": path.addCurve(to: CGPoint(x: p[4], y: p[5]), control1: CGPoint(x: p[0], y: p[1]), control2: CGPoint(x: p[2], y: p[3]))
                default: path.closeSubpath()
                }
            }
            let fill = color(shape.fill), stroke = color(shape.stroke)
            if let fill { context.setFillColor(fill) }
            if let stroke { context.setStrokeColor(stroke); context.setLineWidth(shape.strokeWidth) }
            if fill != nil || stroke != nil {
                context.addPath(path)
                let fillMode: CGPathDrawingMode = shape.evenOdd ? .eoFill : .fill
                let both: CGPathDrawingMode = shape.evenOdd ? .eoFillStroke : .fillStroke
                context.drawPath(using: fill == nil ? .stroke : stroke == nil ? fillMode : both)
            }
            context.restoreGState()
        }
        guard let image = context.makeImage() else { throw ImageRaster.invalid("Could not render the SVG preview.") }
        return image
    }
}
