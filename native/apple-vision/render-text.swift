// Renders a line of text onto a dark 640x360 frame as a PNG. Used only to generate a deterministic
// "text is visible" test frame:  render-text "SAFEWATCH VISUAL TEST 2026" out.png
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write(Data("usage: render-text <text> <out.png>\n".utf8)); exit(64) }
let (w, h) = (640, 360)
let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(red: 0.06, green: 0.08, blue: 0.10, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 34, nil)
let attrs = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(red: 1, green: 1, blue: 1, alpha: 1)] as CFDictionary
let line = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, args[1] as CFString, attrs))
let bounds = CTLineGetBoundsWithOptions(line, [])
ctx.textPosition = CGPoint(x: (CGFloat(w) - bounds.width) / 2, y: (CGFloat(h) - bounds.height) / 2)
CTLineDraw(line, ctx)
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
