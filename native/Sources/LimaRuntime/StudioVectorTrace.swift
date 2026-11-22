import CoreGraphics
import Foundation

extension StudioVector {
    /// Trace directed pixel boundaries into closed paths. Each connected
    /// region is one editable object, including any interior holes.
    static func trace(_ image: CGImage, colors: Int, edge: Int, minArea: Int, mode: String) throws -> StudioVector {
        guard (1...16).contains(colors), (32...512).contains(edge), (1...1_000).contains(minArea),
              ["flat_color", "monochrome", "outline"].contains(mode) else {
            throw ImageRaster.invalid("Use flat_color, monochrome, or outline, up to 16 colors and 32–512 tracing pixels per edge.")
        }
        let scale = min(1, Double(edge) / Double(max(image.width, image.height)))
        let w = max(1, Int(Double(image.width) * scale)), h = max(1, Int(Double(image.height) * scale))
        let working = try ImageRaster.resized(image, width: w, height: h, mode: "stretch")
        let bytes = try ImageRaster.pixels(working)
        let count = w * h
        var histogram: [Int: (count: Int, r: Int, g: Int, b: Int)] = [:]
        var samples = [(Int, Int, Int)?](repeating: nil, count: count)
        for i in 0..<count {
            let p = i * 4, a = Int(bytes[p + 3])
            if a < 96 { continue }
            let r = min(255, Int(bytes[p]) * 255 / a), g = min(255, Int(bytes[p + 1]) * 255 / a), b = min(255, Int(bytes[p + 2]) * 255 / a)
            if mode != "flat_color" && (54 * r + 183 * g + 19 * b) / 256 >= 166 { continue }
            samples[i] = (r, g, b)
            let key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
            let old = histogram[key] ?? (0, 0, 0, 0)
            histogram[key] = (old.count + 1, old.r + r, old.g + g, old.b + b)
        }
        let palette = mode == "flat_color" ? histogram.sorted {
            $0.value.count == $1.value.count ? $0.key < $1.key : $0.value.count > $1.value.count
        }.prefix(colors).map { (_, bin) in (bin.r / bin.count, bin.g / bin.count, bin.b / bin.count) } : [(0, 0, 0)]
        guard !palette.isEmpty else { throw ImageRaster.invalid("No visible colors for this trace.") }

        let pixels = samples.map { sample -> Int in
            guard let (r, g, b) = sample else { return -1 }
            var distance = Int.max, nearest = 0
            for (i, color) in palette.enumerated() {
                let dr = color.0 - r, dg = color.1 - g, db = color.2 - b
                let next = dr * dr + dg * dg + db * db
                if next < distance { distance = next; nearest = i }
            }
            return nearest
        }
        var visited = [Bool](repeating: false, count: count)
        var shapes: [Shape] = []
        var segmentCount = 0
        let vertexRow = w + 1
        let deltas = [1, vertexRow, -1, -vertexRow]
        for start in pixels.indices where !visited[start] && pixels[start] >= 0 {
            let color = pixels[start]
            var queue = [start], cursor = 0
            var edges: [Int: UInt8] = [:]
            visited[start] = true
            func visit(_ i: Int, valid: Bool, vertex: Int, direction: Int) {
                if valid && pixels[i] == color {
                    if !visited[i] { visited[i] = true; queue.append(i) }
                } else { edges[vertex, default: 0] |= 1 << direction }
            }
            while cursor < queue.count {
                let i = queue[cursor], x = i % w, y = i / w, vertex = y * vertexRow + x
                cursor += 1
                visit(i - w, valid: y > 0, vertex: vertex, direction: 0)
                visit(i + 1, valid: x + 1 < w, vertex: vertex + 1, direction: 1)
                visit(i + w, valid: y + 1 < h, vertex: vertex + vertexRow + 1, direction: 2)
                visit(i - 1, valid: x > 0, vertex: vertex + vertexRow, direction: 3)
            }
            guard queue.count >= minArea else { continue }
            var segments: [Segment] = []
            func point(_ vertex: Int) -> [Double] { [Double(vertex % vertexRow), Double(vertex / vertexRow)] }
            for initial in edges.keys.sorted() {
                while let mask = edges[initial], mask != 0 {
                    let first = mask.trailingZeroBitCount
                    var vertex = initial, direction = first
                    segments.append(Segment(command: "M", points: point(vertex)))
                    repeat {
                        guard let current = edges[vertex], current & (1 << direction) != 0 else {
                            throw ImageRaster.invalid("Could not join a traced contour.")
                        }
                        edges[vertex] = current & ~(1 << direction)
                        vertex += deltas[direction]
                        if vertex == initial { break }
                        let available = edges[vertex, default: 0]
                        guard let next = [(direction + 1) % 4, direction, (direction + 3) % 4, (direction + 2) % 4]
                            .first(where: { available & (1 << $0) != 0 }) else {
                            throw ImageRaster.invalid("The trace contains an open contour.")
                        }
                        if next != direction { segments.append(Segment(command: "L", points: point(vertex))) }
                        direction = next
                    } while true
                    segments.append(Segment(command: "Z", points: []))
                }
            }
            segmentCount += segments.count
            guard shapes.count < maxShapes, segmentCount <= maxSegments else {
                throw ImageRaster.invalid("This image is too detailed. Reduce trace resolution and colors or increase minimum region area.")
            }
            let rgb = palette[color]
            let paint = String(format: "#%02x%02x%02x", rgb.0, rgb.1, rgb.2)
            let shape = Shape(id: "shape-\(shapes.count + 1)", segments: segments,
                              fill: mode == "outline" ? "none" : paint, stroke: mode == "outline" ? paint : "none")
            shapes.append(shape)
        }
        let artwork = StudioVector(width: image.width, height: image.height, viewBox: [0, 0, Double(w), Double(h)], shapes: shapes)
        try artwork.validate()
        return artwork
    }
}
