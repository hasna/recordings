import SwiftUI

public struct HasnaLogoMark: View {
    private let size: CGFloat

    public init(size: CGFloat = 22) {
        self.size = size
    }

    public var body: some View {
        Image("HasnaLogo", bundle: .module)
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

public struct HasnaMenuBarIcon: View {
    private let isRecording: Bool
    private let isTranscribing: Bool

    public init(isRecording: Bool, isTranscribing: Bool) {
        self.isRecording = isRecording
        self.isTranscribing = isTranscribing
    }

    public var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Image("HasnaLogo", bundle: .module)
                .resizable()
                .renderingMode(.template)
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 18, height: 18)

            if isRecording {
                Circle()
                    .fill(.red)
                    .frame(width: 6, height: 6)
            } else if isTranscribing {
                Circle()
                    .fill(.tint)
                    .frame(width: 6, height: 6)
            }
        }
        .frame(width: 22, height: 18)
    }
}
