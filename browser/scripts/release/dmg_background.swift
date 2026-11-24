// Draws the DMG window background: Lima → Applications with an arrow and a
// one-line instruction. Run: swift dmg_background.swift <output-dir>
// Writes background.png (640×400) and background@2x.png (1280×800).
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
let size = CGSize(width: 640, height: 400)
// Icon centers used by dmg_settings.py (Finder coordinates, top-left origin).
let app = CGPoint(x: 170, y: 185), applications = CGPoint(x: 470, y: 185)

func render(scale: CGFloat) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let flip = { (point: CGPoint) in CGPoint(x: point.x, y: size.height - point.y) }

    // Soft paper background with a faint vignette.
    NSGradient(colors: [NSColor(white: 0.995, alpha: 1), NSColor(white: 0.955, alpha: 1)])!
        .draw(in: CGRect(origin: .zero, size: size), angle: -90)

    // Quiet wells behind the two icons.
    for center in [app, applications] {
        let well = NSBezierPath(roundedRect: CGRect(x: flip(center).x - 84, y: flip(center).y - 84, width: 168, height: 168), xRadius: 34, yRadius: 34)
        NSColor(white: 0, alpha: 0.035).setFill()
        well.fill()
    }

    // Arrow from Lima to Applications.
    let start = CGPoint(x: flip(app).x + 92, y: flip(app).y), end = CGPoint(x: flip(applications).x - 92, y: flip(applications).y)
    let shaft = NSBezierPath()
    shaft.move(to: start)
    shaft.curve(to: end, controlPoint1: CGPoint(x: start.x + 40, y: start.y + 18), controlPoint2: CGPoint(x: end.x - 40, y: end.y + 18))
    shaft.lineWidth = 3
    shaft.lineCapStyle = .round
    NSColor(white: 0.22, alpha: 0.55).setStroke()
    let dash: [CGFloat] = [1, 9]
    shaft.setLineDash(dash, count: 2, phase: 0)
    shaft.stroke()
    let head = NSBezierPath()
    head.move(to: CGPoint(x: end.x - 13, y: end.y + 11))
    head.line(to: end)
    head.line(to: CGPoint(x: end.x - 13, y: end.y - 9))
    head.lineWidth = 3
    head.lineCapStyle = .round
    head.lineJoinStyle = .round
    head.stroke()

    // Instruction.
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let title: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 17, weight: .semibold),
                                                .foregroundColor: NSColor(white: 0.14, alpha: 1), .paragraphStyle: paragraph]
    let detail: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12.5, weight: .regular),
                                                 .foregroundColor: NSColor(white: 0.42, alpha: 1), .paragraphStyle: paragraph]
    NSAttributedString(string: "Drag Lima to Applications", attributes: title)
        .draw(in: CGRect(x: 0, y: 74, width: size.width, height: 24))
    NSAttributedString(string: "Then open Lima from your Applications folder or Launchpad.", attributes: detail)
        .draw(in: CGRect(x: 0, y: 52, width: size.width, height: 18))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

try render(scale: 1).write(to: output.appendingPathComponent("background.png"))
try render(scale: 2).write(to: output.appendingPathComponent("background@2x.png"))
