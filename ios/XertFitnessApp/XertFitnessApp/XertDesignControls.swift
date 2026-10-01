import SwiftUI
import UIKit

enum XertButtonVariant: CaseIterable {
    case primary, ghost, danger, quiet
    var foreground: Color {
        switch self {
        case .primary: return XertTokens.textInverse
        case .danger: return XertTokens.stateDangerPale
        case .ghost, .quiet: return XertTokens.textPrimary
        }
    }
    var background: Color {
        self == .primary ? XertTokens.accentDefault : self == .quiet ? XertTokens.surfaceBase : XertTokens.surfaceRaised
    }
    var interaction: XertInteraction { self == .danger ? .destructive : .action }
}

struct XertControlButtonStyle: ButtonStyle {
    var variant: XertButtonVariant = .primary
    var expands = false
    func makeBody(configuration: Configuration) -> some View {
        XertButtonVisual(label: configuration.label, pressed: configuration.isPressed, variant: variant, expands: expands)
    }
}

private struct XertButtonVisual<Label: View>: View {
    let label: Label
    let pressed: Bool
    let variant: XertButtonVariant
    let expands: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        label.xertTypography(.body).fontWeight(.semibold)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(variant.foreground)
            .frame(maxWidth: expands ? .infinity : nil)
            .padding(.horizontal, XertSpace.lg).padding(.vertical, XertSpace.md)
            .frame(minWidth: XertTokens.controlHeight, minHeight: XertTokens.controlHeight)
            .background(pressed ? (variant == .primary ? XertTokens.accentHover : XertTokens.surfaceOverlay) : variant.background)
            .clipShape(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive, style: .continuous).strokeBorder(variant == .danger ? XertTokens.stateDanger : XertTokens.borderStrong, lineWidth: XertTokens.navLineWidth))
            .opacity(isEnabled ? 1 : Double(XertTokens.nativeOpacityDisabled))
            .scaleEffect(XertMotion.pressScale(pressed: pressed && isEnabled, reduceMotion: reduceMotion))
            .animation(XertMotion.spring(reduceMotion: reduceMotion), value: pressed)
            .contentShape(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive))
    }
}

@MainActor
struct XertButton: View {
    let title: String
    var icon: String? = nil
    var variant: XertButtonVariant = .primary
    var isLoading = false
    var error: String? = nil
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @FocusState private var focused: Bool

    private var state: XertControlState { .resolve(enabled: isEnabled, loading: isLoading, error: error != nil, focused: focused) }
    var body: some View {
        VStack(alignment: .leading, spacing: XertSpace.sm) {
            Button {
                guard state.acceptsInput else { return }
                XertHaptics.play(variant.interaction.haptic)
                action()
            } label: {
                HStack(spacing: XertSpace.sm) {
                    if isLoading { ProgressView().tint(variant.foreground).accessibilityHidden(true) }
                    if let icon { Image(systemName: icon).accessibilityHidden(true) }
                    Text(title).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity)
            }
            .buttonStyle(XertControlButtonStyle(variant: variant))
            .focused($focused)
            .disabled(!state.acceptsInput)
            .overlay(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive).strokeBorder(focused ? XertTokens.focusRing : Color.clear, lineWidth: XertTokens.focusWidth))
            .accessibilityLabel(title).accessibilityValue(isLoading ? "In progress" : "")
            if let error { XertInlineError(message: error) }
        }
    }
}

@MainActor
struct XertField: View {
    let title: String
    @Binding var text: String
    var prompt: String = ""
    var error: String? = nil
    var isLoading = false
    var axis: Axis = .horizontal
    var lineRange: ClosedRange<Int> = 1...6
    var keyboardType: UIKeyboardType = .default
    var textContentType: UITextContentType? = nil
    var externalFocus: FocusState<Bool>.Binding? = nil
    @Environment(\.isEnabled) private var isEnabled
    @FocusState private var focused: Bool
    private var fieldFocus: FocusState<Bool>.Binding { externalFocus ?? $focused }
    private var state: XertControlState { .resolve(enabled: isEnabled, loading: isLoading, error: error != nil, focused: fieldFocus.wrappedValue) }

    var body: some View {
        VStack(alignment: .leading, spacing: XertSpace.sm) {
            Text(title).xertTypography(.caption).foregroundStyle(XertTokens.textSecondary)
            HStack(spacing: XertSpace.sm) {
                TextField(title, text: $text, prompt: Text(prompt), axis: axis)
                    .xertTypography(.body).foregroundStyle(XertTokens.textPrimary)
                    .lineLimit(lineRange).keyboardType(keyboardType).textContentType(textContentType)
                    .focused(fieldFocus).disabled(!state.acceptsInput)
                    .accessibilityLabel(title).accessibilityHint(error ?? "")
                if isLoading { ProgressView().accessibilityLabel("Loading \(title)") }
            }
            .padding(XertSpace.md).frame(minHeight: XertTokens.controlHeight)
            .background(XertTokens.surfaceSunken)
            .clipShape(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive))
            .overlay(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive).strokeBorder(state.border, lineWidth: fieldFocus.wrappedValue ? XertTokens.focusWidth : XertTokens.navLineWidth))
            .opacity(isEnabled ? 1 : Double(XertTokens.nativeOpacityDisabled))
            if let error { XertInlineError(message: error) }
        }
    }
}

struct XertChoice<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var id: Value { value }
}

@MainActor
struct XertSegmented<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let choices: [XertChoice<Value>]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.isEnabled) private var isEnabled
    private var userSelection: Binding<Value> {
        Binding(get: { selection }, set: { value in
            guard isEnabled, value != selection else { return }
            XertHaptics.play(XertInteraction.selection.haptic); selection = value
        })
    }
    private var picker: some View {
        Picker(title, selection: userSelection) {
            ForEach(choices) { choice in Text(choice.label).tag(choice.value) }
        }.accessibilityLabel(title).tint(XertTokens.accentDefault)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: XertSpace.sm) {
            Text(title).xertTypography(.caption).foregroundStyle(XertTokens.textSecondary)
            if dynamicTypeSize.isAccessibilitySize {
                picker.pickerStyle(.menu).xertTypography(.body).frame(minHeight: XertTokens.controlHeight)
            } else {
                XertNativeSegments(title: title, selection: userSelection, choices: choices)
                    .frame(minHeight: XertTokens.controlHeight)
            }
        }
    }
}

/// SwiftUI's segmented Picker retains a 32pt UIKit control inside a larger
/// frame. Size the native control itself so its real hit region meets the
/// semantic minimum while keeping native segment selection/accessibility.
private final class XertMinimumHeightSegments: UISegmentedControl {
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width, height: max(size.height, XertTokens.controlHeight))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let fit = super.sizeThatFits(size)
        return CGSize(width: fit.width, height: max(fit.height, XertTokens.controlHeight))
    }
}

/// Keep the native control centered in the space SwiftUI actually allocates.
/// On iOS18.5 the native control can be 45pt tall inside a 44pt SwiftUI host.
/// Directly hosting that control aligns its top edge with a 44pt host, clipping
/// the bottom of its hit target. A container shares their centers instead.
private final class XertSegmentsContainer: UIView {
    let control = XertMinimumHeightSegments(items: [])

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(control)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        addSubview(control)
    }

    override var intrinsicContentSize: CGSize { control.intrinsicContentSize }

    override func sizeThatFits(_ size: CGSize) -> CGSize { control.sizeThatFits(size) }

    override func layoutSubviews() {
        super.layoutSubviews()
        control.frame = bounds
        // Use the actual fitted control size; do not assume UIKit accepted the
        // requested height or expand hit testing outside the allocated host.
        control.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

@MainActor
private struct XertNativeSegments<Value: Hashable>: UIViewRepresentable {
    let title: String
    @Binding var selection: Value
    let choices: [XertChoice<Value>]
    @Environment(\.isEnabled) private var isEnabled
    @ScaledMetric(relativeTo: .body) private var fontSize = XertTokens.nativeTypeBody

    func makeUIView(context: Context) -> XertSegmentsContainer {
        let container = XertSegmentsContainer(frame: .zero)
        let control = container.control
        container.setContentHuggingPriority(.defaultLow, for: .horizontal)
        container.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return container
    }

    func updateUIView(_ container: XertSegmentsContainer, context: Context) {
        let control = container.control
        context.coordinator.parent = self
        if control.numberOfSegments != choices.count || choices.enumerated().contains(where: { control.titleForSegment(at: $0.offset) != $0.element.label }) {
            control.removeAllSegments()
            for (index, choice) in choices.enumerated() {
                control.insertSegment(withTitle: choice.label, at: index, animated: false)
            }
        }
        control.selectedSegmentIndex = choices.firstIndex(where: { $0.value == selection }) ?? UISegmentedControl.noSegment
        control.isEnabled = isEnabled
        control.accessibilityLabel = title
        control.backgroundColor = UIColor(XertTokens.surfaceSunken)
        control.selectedSegmentTintColor = UIColor(XertTokens.accentDefault)
        let font = UIFont.systemFont(ofSize: fontSize)
        control.setTitleTextAttributes([.font: font, .foregroundColor: UIColor(XertTokens.textPrimary)], for: .normal)
        control.setTitleTextAttributes([.font: font, .foregroundColor: UIColor(XertTokens.textInverse)], for: .selected)
        control.invalidateIntrinsicContentSize()
        container.invalidateIntrinsicContentSize()
        container.setNeedsLayout()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: XertSegmentsContainer, context: Context) -> CGSize? {
        let intrinsic = uiView.intrinsicContentSize
        return CGSize(width: proposal.width ?? intrinsic.width, height: max(intrinsic.height, XertTokens.controlHeight))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject {
        var parent: XertNativeSegments
        init(_ parent: XertNativeSegments) { self.parent = parent }
        @objc func changed(_ control: UISegmentedControl) {
            guard control.isEnabled, parent.choices.indices.contains(control.selectedSegmentIndex) else { return }
            parent.selection = parent.choices[control.selectedSegmentIndex].value
        }
    }
}

@MainActor
struct XertToggleRow: View {
    let title: String
    var detail: String? = nil
    @Binding var isOn: Bool
    var error: String? = nil
    @Environment(\.isEnabled) private var isEnabled
    private var userValue: Binding<Bool> {
        Binding(get: { isOn }, set: { value in
            guard isEnabled, value != isOn else { return }
            XertHaptics.play(XertInteraction.selection.haptic); isOn = value
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: XertSpace.sm) {
            Toggle(isOn: userValue) {
                VStack(alignment: .leading, spacing: XertSpace.xs) {
                    Text(title).xertTypography(.body).foregroundStyle(XertTokens.textPrimary)
                    if let detail { Text(detail).xertTypography(.caption).foregroundStyle(XertTokens.textMuted) }
                }.fixedSize(horizontal: false, vertical: true)
            }.tint(XertTokens.accentDefault).frame(minHeight: XertTokens.controlHeight)
            .accessibilityLabel(title).accessibilityValue(isOn ? "On" : "Off").accessibilityHint(detail ?? "")
            if let error { XertInlineError(message: error) }
        }
    }
}

@MainActor
struct XertMenuField<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let choices: [XertChoice<Value>]
    var error: String? = nil
    @Environment(\.isEnabled) private var isEnabled
    private var userSelection: Binding<Value> {
        Binding(get: { selection }, set: { value in
            guard isEnabled, value != selection else { return }
            XertHaptics.play(XertInteraction.selection.haptic); selection = value
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: XertSpace.sm) {
            Text(title).xertTypography(.caption).foregroundStyle(XertTokens.textSecondary)
            Picker(title, selection: userSelection) {
                ForEach(choices) { choice in Text(choice.label).tag(choice.value) }
            }.pickerStyle(.menu).xertTypography(.body).tint(XertTokens.accentDefault)
                .frame(maxWidth: .infinity, minHeight: XertTokens.controlHeight, alignment: .leading)
                .padding(.horizontal, XertSpace.md).background(XertTokens.surfaceSunken)
                .clipShape(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive))
                .overlay(RoundedRectangle(cornerRadius: XertTokens.nativeRadiusInteractive).strokeBorder(error == nil ? XertTokens.borderStrong : XertTokens.stateDanger, lineWidth: XertTokens.navLineWidth))
                .accessibilityLabel(title).accessibilityHint(error ?? "")
            if let error { XertInlineError(message: error) }
        }
    }
}

@MainActor
struct XertNavigationRow: View {
    let title: String
    let detail: String
    let icon: String
    var onOpen: () -> Void
    var body: some View {
        Button {
            XertHaptics.play(XertInteraction.selection.haptic); onOpen()
        } label: {
            HStack(spacing: XertSpace.md) {
                Image(systemName: icon).frame(width: XertTokens.nativeIconSize).foregroundStyle(XertTokens.accentDefault).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: XertSpace.xs) {
                    Text(title).xertTypography(.heading).foregroundStyle(XertTokens.textPrimary)
                    Text(detail).xertTypography(.caption).foregroundStyle(XertTokens.textMuted)
                }.fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: XertSpace.sm)
                Image(systemName: "chevron.right").foregroundStyle(XertTokens.accentDefault).accessibilityHidden(true)
            }.frame(maxWidth: .infinity, minHeight: XertTokens.controlHeight, alignment: .leading)
        }.buttonStyle(XertControlButtonStyle(variant: .quiet)).accessibilityLabel(title).accessibilityHint(detail)
    }
}
