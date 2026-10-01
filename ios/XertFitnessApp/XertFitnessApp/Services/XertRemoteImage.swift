import ImageIO
import Combine
import Foundation
import SwiftUI
import UIKit

/// A bounded, decoded-image cache for XERT's CMS-backed photography.
///
/// `AsyncImage` is convenient, but repeated list/hero construction can decode
/// the original upload again on the main thread. XERT remote images are
/// downsampled to the size the view can actually display and retained in a
/// small memory cache, keeping the home carousel and team directory smooth on
/// older iPhones without turning the cache into unbounded app state.
@MainActor
private final class XertRemoteImageLoader: ObservableObject {
    @Published private(set) var image: UIImage?

    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 40
        cache.totalCostLimit = 48 * 1_024 * 1_024
        return cache
    }()

    private var representedKey: String?

    func load(url: URL, maximumPixelDimension: Int, displayScale: CGFloat) async {
        let boundedDimension = min(max(maximumPixelDimension, 96), 2_048)
        let key = "\(url.absoluteString)#\(boundedDimension)"

        if representedKey != key {
            representedKey = key
            image = nil
        }

        if let cached = Self.cache.object(forKey: key as NSString) {
            image = cached
            return
        }

        var request = URLRequest(
            url: url,
            cachePolicy: .returnCacheDataElseLoad,
            timeoutInterval: 20
        )
        request.setValue("image/*", forHTTPHeaderField: "Accept")

        #if DEBUG
        // UI-test fixture mode never loads remote images.
        if XertUITestFixtures.isActive { return }
        #endif

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            try Task.checkCancellation()
            guard
                let http = response as? HTTPURLResponse,
                (200...299).contains(http.statusCode),
                !data.isEmpty,
                data.count <= 12 * 1_024 * 1_024
            else { return }

            let decoded = await Task.detached(priority: .utility) {
                Self.downsample(
                    data: data,
                    maximumPixelDimension: boundedDimension,
                    displayScale: displayScale
                )
            }.value
            try Task.checkCancellation()
            guard representedKey == key, let decoded else { return }

            let cost = decoded.cgImage.map { $0.bytesPerRow * $0.height } ?? data.count
            Self.cache.setObject(decoded, forKey: key as NSString, cost: cost)
            image = decoded
        } catch is CancellationError {
            return
        } catch {
            // The supplied placeholder remains visible. A later view task or
            // URL change retries without persisting a failed cache entry.
        }
    }

    nonisolated private static func downsample(
        data: Data,
        maximumPixelDimension: Int,
        displayScale: CGFloat
    ) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }

        let thumbnailOptions = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelDimension,
        ] as CFDictionary
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else {
            return nil
        }
        return UIImage(cgImage: thumbnail, scale: max(displayScale, 1), orientation: .up)
    }
}

/// Drop-in remote photography view with cancellation, memory caching and
/// off-main downsampling. Its placeholder stays rendered for network and
/// decoding failures, so remote CMS media can never collapse a native layout.
struct XertRemoteImage<Placeholder: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @StateObject private var loader = XertRemoteImageLoader()

    let url: URL
    let maximumPointDimension: CGFloat
    let contentMode: ContentMode
    private let placeholder: () -> Placeholder

    init(
        url: URL,
        maximumPointDimension: CGFloat,
        contentMode: ContentMode = .fill,
        @ViewBuilder placeholder: @escaping () -> Placeholder
    ) {
        self.url = url
        self.maximumPointDimension = maximumPointDimension
        self.contentMode = contentMode
        self.placeholder = placeholder
    }

    var body: some View {
        ZStack {
            placeholder()
                .opacity(loader.image == nil ? 1 : 0)

            if let image = loader.image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .transition(reduceMotion ? .identity : .opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: loader.image != nil)
        .task(id: requestKey) {
            await loader.load(
                url: url,
                maximumPixelDimension: maximumPixelDimension,
                displayScale: displayScale
            )
        }
    }

    private var maximumPixelDimension: Int {
        Int(min(maximumPointDimension * max(displayScale, 1), 2_048).rounded(.up))
    }

    private var requestKey: String {
        "\(url.absoluteString)#\(maximumPixelDimension)"
    }
}
