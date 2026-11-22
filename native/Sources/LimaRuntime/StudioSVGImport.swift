import CoreGraphics
import Foundation

extension StudioVector {
    static func parse(_ data: Data) throws -> StudioVector {
        guard data.count <= 4_000_000, let xml = String(data: data, encoding: .utf8),
              !xml.localizedCaseInsensitiveContains("<!DOCTYPE"), !xml.localizedCaseInsensitiveContains("<!ENTITY") else {
            throw ImageRaster.invalid("Use a UTF-8 SVG without a document type or entity declarations.")
        }
        let parser = XMLParser(data: data)
        let reader = StudioSVGImport()
        parser.delegate = reader
        parser.shouldResolveExternalEntities = false
        guard parser.parse(), let artwork = reader.artwork, reader.error == nil else {
            throw reader.error ?? ImageRaster.invalid("The SVG is malformed or contains unsupported content.")
        }
        try artwork.validate()
        return artwork
    }
}

private final class StudioSVGImport: NSObject, XMLParserDelegate {
    private struct Style {
        var fill = "#000000"
        var stroke = "none"
        var strokeWidth = 1.0
        var opacity = 1.0
        var evenOdd = false
        var matrix = CGAffineTransform.identity
        var group: String?
    }

    private var styles: [Style] = []
    private var names: [String] = []
    private var ids: Set<String> = []
    private var segments = 0
    var artwork: StudioVector?
    var error: Error?

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?,
                attributes values: [String: String]) {
        do { try enter(name, values) }
        catch { self.error = error; parser.abortParsing() }
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        if !names.isEmpty { names.removeLast(); styles.removeLast() }
    }

    func parser(_ parser: XMLParser, foundProcessingInstructionWithTarget target: String, data: String?) {
        error = ImageRaster.invalid("SVG processing instructions are unsupported.")
        parser.abortParsing()
    }

    private func enter(_ name: String, _ attrs: [String: String]) throws {
        let geometry: [String: Set<String>] = [
            "svg": ["width", "height", "viewBox", "xmlns", "version"],
            "g": ["data-group"], "title": [], "desc": [],
            "path": ["d"], "rect": ["x", "y", "width", "height"],
            "circle": ["cx", "cy", "r"], "ellipse": ["cx", "cy", "rx", "ry"],
            "polygon": ["points"], "polyline": ["points"], "line": ["x1", "y1", "x2", "y2"],
        ]
        let allowed = Set(["id", "fill", "stroke", "stroke-width", "opacity", "fill-rule", "transform"])
        guard names.count < 20, let fields = geometry[name], Set(attrs.keys).isSubset(of: fields.union(allowed)),
              names.isEmpty ? name == "svg" && artwork == nil : ["svg", "g"].contains(names.last!) && name != "svg" else {
            throw ImageRaster.invalid("The SVG uses unsupported elements or attributes. Import solid paths and simple shapes without external resources.")
        }
        if let namespace = attrs["xmlns"], namespace != "http://www.w3.org/2000/svg" {
            throw ImageRaster.invalid("Unrecognized SVG namespace.")
        }
        var style = styles.last ?? Style()
        if let fill = attrs["fill"] { style.fill = try StudioVector.paint(fill) }
        if let stroke = attrs["stroke"] { style.stroke = try StudioVector.paint(stroke) }
        if attrs["stroke-width"] != nil { style.strokeWidth = try number(attrs, "stroke-width") }
        if attrs["opacity"] != nil { style.opacity *= try number(attrs, "opacity") }
        if let rule = attrs["fill-rule"] {
            guard ["evenodd", "nonzero"].contains(rule) else { throw ImageRaster.invalid("Invalid SVG fill rule.") }
            style.evenOdd = rule == "evenodd"
        }
        if let declaration = attrs["transform"] {
            style.matrix = try parseTransform(declaration).concatenating(style.matrix)
        }

        switch name {
        case "svg":
            let viewBox = try attrs["viewBox"].map(values)
            if let viewBox, viewBox.count != 4 { throw ImageRaster.invalid("The SVG viewBox needs four values.") }
            let width = try number(attrs, "width", default: viewBox?[2] ?? 0)
            let height = try number(attrs, "height", default: viewBox?[3] ?? 0)
            try ImageRaster.validate(Int(width.rounded(.up)), Int(height.rounded(.up)))
            artwork = StudioVector(width: Int(width.rounded(.up)), height: Int(height.rounded(.up)),
                                  viewBox: viewBox ?? [0, 0, width, height], shapes: [])
        case "g":
            style.group = (attrs["data-group"] ?? attrs["id"]).map { String($0.prefix(120)) } ?? style.group
        case "title", "desc":
            break
        default:
            let path = try outline(name, attrs)
            try StudioVector.validateSegments(path)
            segments += path.count
            guard var artwork, artwork.shapes.count < StudioVector.maxShapes, segments <= StudioVector.maxSegments else {
                throw ImageRaster.invalid("The SVG exceeds the editable geometry limit.")
            }
            let candidate = attrs["id"].flatMap { $0.utf8.count <= 120 && !$0.isEmpty ? $0 : nil }
            let id = candidate.flatMap { ids.contains($0) ? nil : $0 } ?? "shape-" + UUID().uuidString
            ids.insert(id)
            artwork.shapes.append(StudioVector.Shape(id: id, segments: path, fill: style.fill, stroke: style.stroke,
                strokeWidth: style.strokeWidth, opacity: style.opacity, matrix: StudioVector.matrix(style.matrix),
                group: style.group, evenOdd: style.evenOdd))
            self.artwork = artwork
        }
        names.append(name)
        styles.append(style)
    }

    private func number(_ attrs: [String: String], _ key: String, default fallback: Double = 0) throws -> Double {
        guard let raw = attrs[key] else { return fallback }
        let text = raw.hasSuffix("px") ? String(raw.dropLast(2)) : raw
        guard let value = Double(text), StudioVector.bounded(value) else { throw ImageRaster.invalid("Invalid SVG number for \(key).") }
        return value
    }

    private func values(_ raw: String) throws -> [Double] {
        let tokens = raw.split { $0.isWhitespace || $0 == "," }
        let numbers = tokens.compactMap { Double($0) }
        guard tokens.count == numbers.count, numbers.allSatisfy(StudioVector.bounded) else { throw ImageRaster.invalid("Invalid SVG geometry.") }
        return numbers
    }

    private func outline(_ name: String, _ attrs: [String: String]) throws -> [StudioVector.Segment] {
        func segment(_ cmd: String, _ numbers: Double...) -> StudioVector.Segment { .init(command: cmd, points: numbers) }
        switch name {
        case "path": return try StudioVector.parsePath(attrs["d"] ?? "")
        case "rect":
            let x = try number(attrs, "x"), y = try number(attrs, "y")
            let w = try number(attrs, "width"), h = try number(attrs, "height")
            guard w > 0, h > 0 else { throw ImageRaster.invalid("An SVG rectangle has invalid dimensions.") }
            return [segment("M", x, y), segment("L", x + w, y), segment("L", x + w, y + h), segment("L", x, y + h), segment("Z")]
        case "circle", "ellipse":
            let x = try number(attrs, "cx"), y = try number(attrs, "cy")
            let rx = try number(attrs, name == "circle" ? "r" : "rx"), ry = try number(attrs, name == "circle" ? "r" : "ry")
            guard rx > 0, ry > 0 else { throw ImageRaster.invalid("An SVG ellipse has invalid dimensions.") }
            let dx = rx * 0.5522847498, dy = ry * 0.5522847498
            return [segment("M", x + rx, y), segment("C", x + rx, y + dy, x + dx, y + ry, x, y + ry),
                segment("C", x - dx, y + ry, x - rx, y + dy, x - rx, y), segment("C", x - rx, y - dy, x - dx, y - ry, x, y - ry),
                segment("C", x + dx, y - ry, x + rx, y - dy, x + rx, y), segment("Z")]
        case "line":
            return [try segment("M", number(attrs, "x1"), number(attrs, "y1")), try segment("L", number(attrs, "x2"), number(attrs, "y2"))]
        default:
            let points = try values(attrs["points"] ?? "")
            guard points.count >= 4, points.count.isMultiple(of: 2) else { throw ImageRaster.invalid("An SVG polygon has invalid coordinates.") }
            var path = stride(from: 0, to: points.count, by: 2).map { segment($0 == 0 ? "M" : "L", points[$0], points[$0 + 1]) }
            if name == "polygon" { path.append(segment("Z")) }
            return path
        }
    }

    private func parseTransform(_ input: String) throws -> CGAffineTransform {
        let regex = try NSRegularExpression(pattern: #"([A-Za-z]+)\(([^()]*)\)"#)
        let range = NSRange(input.startIndex..<input.endIndex, in: input)
        let rest = regex.stringByReplacingMatches(in: input, range: range, withTemplate: "")
        guard rest.allSatisfy({ $0.isWhitespace || $0 == "," }) else { throw ImageRaster.invalid("Invalid SVG transform.") }
        var result = CGAffineTransform.identity
        for match in regex.matches(in: input, range: range) {
            let name = String(input[Range(match.range(at: 1), in: input)!])
            let p = try values(String(input[Range(match.range(at: 2), in: input)!]))
            let next: CGAffineTransform
            switch (name, p.count) {
            case ("matrix", 6): next = StudioVector.transform(p)
            case ("translate", 1), ("translate", 2): next = .init(translationX: p[0], y: p.count == 2 ? p[1] : 0)
            case ("scale", 1), ("scale", 2): next = .init(scaleX: p[0], y: p.count == 2 ? p[1] : p[0])
            case ("rotate", 1): next = .init(rotationAngle: p[0] * .pi / 180)
            case ("rotate", 3):
                next = CGAffineTransform(translationX: -p[1], y: -p[2])
                    .concatenating(.init(rotationAngle: p[0] * .pi / 180)).concatenating(.init(translationX: p[1], y: p[2]))
            default: throw ImageRaster.invalid("Unsupported SVG transform.")
            }
            result = next.concatenating(result)
        }
        return result
    }
}
