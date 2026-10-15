import Foundation
import Vision
import AppKit
import PDFKit

// OCR a single image file with the macOS Vision framework and print the
// recognized text, one line per detected block. Fast, accurate, on-device,
// AGPL-safe (no external service). Usage: ocr [--json] <image-path>
//
// PDF mode: ocr --pdf <file.pdf> --pages 3,4,9
// Renders each page with PDFKit onto opaque white (a transparent background reads as nothing)
// at 200 DPI, long side capped at 2800 px, and prints one JSON line per page: {"page":3,"text":"…"}.
// One process reads many pages, so a scanned book does not pay a process start per page.

struct PixelBounds: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct TextBlock: Codable {
    let text: String
    let confidence: Float
    let bounds: PixelBounds
}

struct OcrDocument: Codable {
    let width: Int
    let height: Int
    let blocks: [TextBlock]
}

func recognizeText(
    _ cgImage: CGImage,
    recognitionLevel: VNRequestTextRecognitionLevel,
    languageCorrection: Bool
) throws -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = recognitionLevel
    request.usesLanguageCorrection = languageCorrection
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    return request.results ?? []
}


struct PdfPageText: Codable {
    let page: Int
    let text: String
}

func recognizePageText(_ image: CGImage) -> String {
    let observations =
        (try? recognizeText(image, recognitionLevel: .accurate, languageCorrection: true))
        ?? (try? recognizeText(image, recognitionLevel: .accurate, languageCorrection: false))
        ?? []
    return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func renderPage(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    let scale = min(200.0 / 72.0, 2800.0 / max(bounds.width, bounds.height))
    let width = Int((bounds.width * scale).rounded())
    let height = Int((bounds.height * scale).rounded())
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceGray(),
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return nil }
    context.setFillColor(gray: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

if CommandLine.arguments.count > 2 && CommandLine.arguments[1] == "--pdf" {
    let pdfPath = CommandLine.arguments[2]
    var pages: [Int] = []
    if let flag = CommandLine.arguments.firstIndex(of: "--pages"), flag + 1 < CommandLine.arguments.count {
        pages = CommandLine.arguments[flag + 1].split(separator: ",").compactMap { Int($0) }
    }
    guard let document = PDFDocument(url: URL(fileURLWithPath: pdfPath)) else {
        FileHandle.standardError.write("could not open PDF\n".data(using: .utf8)!)
        exit(1)
    }
    if pages.isEmpty { pages = Array(1...max(1, document.pageCount)) }
    let encoder = JSONEncoder()
    for number in pages {
        autoreleasepool {
            var text = ""
            if let page = document.page(at: number - 1), let image = renderPage(page) {
                text = recognizePageText(image)
            }
            if let data = try? encoder.encode(PdfPageText(page: number, text: text)),
               let line = String(data: data, encoding: .utf8) {
                print(line)
                fflush(stdout)
            }
        }
    }
    exit(0)
}

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: ocr <image-path>\n".data(using: .utf8)!)
    exit(1)
}

let jsonOutput = CommandLine.arguments.dropFirst().first == "--json"
let pathIndex = jsonOutput ? 2 : 1
guard CommandLine.arguments.count > pathIndex else {
    FileHandle.standardError.write("usage: ocr [--json] <image-path>\n".data(using: .utf8)!)
    exit(1)
}
let path = CommandLine.arguments[pathIndex]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("could not load image\n".data(using: .utf8)!)
    exit(1)
}

let results: [VNRecognizedTextObservation]
do {
    do {
        results = try recognizeText(
            cgImage,
            recognitionLevel: .accurate,
            languageCorrection: true
        )
    } catch {
        do {
            // Language correction can be unavailable on a valid macOS Vision
            // installation. OCR remains useful without that optional pass.
            results = try recognizeText(
                cgImage,
                recognitionLevel: .accurate,
                languageCorrection: false
            )
        } catch {
            // Vision's accurate recognizer can reject small window captures.
            // The fast recognizer still returns bounded local text for fusion.
            results = try recognizeText(
                cgImage,
                recognitionLevel: .fast,
                languageCorrection: false
            )
        }
    }
    if jsonOutput {
        let imageWidth = cgImage.width
        let imageHeight = cgImage.height
        let blocks = results.compactMap { observation -> TextBlock? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let normalized = observation.boundingBox
            // Vision uses a lower-left normalized origin. Screen and image consumers use top-left pixels.
            let x = Int((normalized.origin.x * CGFloat(imageWidth)).rounded())
            let y = Int(((1.0 - normalized.origin.y - normalized.height) * CGFloat(imageHeight)).rounded())
            let width = Int((normalized.width * CGFloat(imageWidth)).rounded())
            let height = Int((normalized.height * CGFloat(imageHeight)).rounded())
            return TextBlock(
                text: candidate.string,
                confidence: candidate.confidence,
                bounds: PixelBounds(
                    x: max(0, min(imageWidth, x)),
                    y: max(0, min(imageHeight, y)),
                    width: max(0, min(imageWidth - max(0, x), width)),
                    height: max(0, min(imageHeight - max(0, y), height))
                )
            )
        }
        let document = OcrDocument(width: imageWidth, height: imageHeight, blocks: blocks)
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(document), let json = String(data: data, encoding: .utf8) {
            print(json)
        } else {
            FileHandle.standardError.write("OCR JSON encoding failed\n".data(using: .utf8)!)
            exit(1)
        }
    } else {
        for observation in results {
            if let candidate = observation.topCandidates(1).first {
                print(candidate.string)
            }
        }
    }
} catch {
    FileHandle.standardError.write("OCR failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
