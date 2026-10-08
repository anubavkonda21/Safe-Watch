// safewatch-vision: a tiny local image-analysis helper built on Apple's Vision framework.
//
//   safewatch-vision [--min-confidence 0.1] [--max-labels 8] -- image1.jpg image2.jpg ...
//
// For each image it prints structured, descriptive observations as one JSON document on stdout:
//   classification  image-level labels with confidences (Apple's scene/object taxonomy)
//   object          localised people and animals with a bounding box (normalised, origin top-left)
//   text            recognised text (OCR) with a bounding box
// It performs no safety judgement, no face recognition and no network access. Image paths are plain
// arguments (never interpreted by a shell). Everything runs on this machine.
import Foundation
import Vision
import ImageIO
import CoreGraphics

struct Region: Codable { var x: Double; var y: Double; var width: Double; var height: Double }
struct Observation: Codable { var type: String; var label: String; var confidence: Double?; var region: Region?; var text: String? }
struct FrameOut: Codable { var index: Int; var ok: Bool; var width: Int?; var height: Int?; var error: String?; var elapsedMs: Double; var observations: [Observation] }
struct Output: Codable { var provider: String; var frames: [FrameOut] }

var minConfidence = 0.10
var maxLabels = 8
var paths: [String] = []
var args = Array(CommandLine.arguments.dropFirst())
var onlyPaths = false
while !args.isEmpty {
    let a = args.removeFirst()
    if onlyPaths { paths.append(a); continue }
    switch a {
    case "--": onlyPaths = true
    case "--help": print("usage: safewatch-vision [--min-confidence 0.1] [--max-labels 8] -- image.jpg ..."); exit(0)
    case "--min-confidence": if let v = args.first, let d = Double(v) { minConfidence = d; args.removeFirst() }
    case "--max-labels": if let v = args.first, let n = Int(v) { maxLabels = n; args.removeFirst() }
    default: FileHandle.standardError.write(Data("unknown option\n".utf8)); exit(64)
    }
}

/// Vision reports boxes with a bottom-left origin; SafeWatch uses top-left. Clamp to [0, 1].
func region(_ box: CGRect) -> Region? {
    let x = max(0, min(1, Double(box.origin.x)))
    let y = max(0, min(1, 1 - Double(box.origin.y + box.size.height)))
    let w = max(0, min(1 - x, Double(box.size.width)))
    let h = max(0, min(1 - y, Double(box.size.height)))
    return w > 0 && h > 0 ? Region(x: x, y: y, width: w, height: h) : nil
}

func analyse(index: Int, path: String) -> FrameOut {
    let started = DispatchTime.now()
    func elapsed() -> Double { Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6 }
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let type = CGImageSourceGetType(source) as String?,
          type == "public.jpeg" || type == "public.png",
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else {
        return FrameOut(index: index, ok: false, width: nil, height: nil, error: "decode-failed", elapsedMs: elapsed(), observations: [])
    }
    var orientation = CGImagePropertyOrientation.up
    if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
       let raw = props[kCGImagePropertyOrientation] as? UInt32, let o = CGImagePropertyOrientation(rawValue: raw) { orientation = o }

    let classify = VNClassifyImageRequest()
    let humans = VNDetectHumanRectanglesRequest()
    let animals = VNRecognizeAnimalsRequest()
    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .accurate
    text.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    do { try handler.perform([classify, humans, animals, text]) } catch {
        return FrameOut(index: index, ok: false, width: image.width, height: image.height, error: "inference-failed", elapsedMs: elapsed(), observations: [])
    }

    var out: [Observation] = []
    let labels = (classify.results ?? []).filter { Double($0.confidence) >= minConfidence }.sorted { $0.confidence > $1.confidence }.prefix(maxLabels)
    for l in labels { out.append(Observation(type: "classification", label: l.identifier, confidence: Double(l.confidence), region: nil, text: nil)) }
    for h in humans.results ?? [] { out.append(Observation(type: "object", label: "person", confidence: Double(h.confidence), region: region(h.boundingBox), text: nil)) }
    for a in animals.results ?? [] { if let top = a.labels.first { out.append(Observation(type: "object", label: top.identifier.lowercased(), confidence: Double(top.confidence), region: region(a.boundingBox), text: nil)) } }
    for t in text.results ?? [] {
        if let c = t.topCandidates(1).first, !c.string.isEmpty {
            out.append(Observation(type: "text", label: "text", confidence: Double(c.confidence), region: region(t.boundingBox), text: String(c.string.prefix(200))))
        }
    }
    return FrameOut(index: index, ok: true, width: image.width, height: image.height, error: nil, elapsedMs: elapsed(), observations: out)
}

let frames = paths.enumerated().map { analyse(index: $0.offset, path: $0.element) }
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try! encoder.encode(Output(provider: "apple-vision", frames: frames)))
