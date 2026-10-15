// Diagnostic-only OS input. No AppleEvents, System Events, clipboard or DOM injection.
import AppKit
import ApplicationServices
import Carbon
import Foundation

func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
func inputSourceID() -> String {
    let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    guard let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return "unknown" }
    return Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue() as String
}
func permissions() -> [String: Any] {
    return ["postEventAccess": CGPreflightPostEventAccess(), "accessibilityTrusted": AXIsProcessTrusted(),
            "screenCaptureAccess": CGPreflightScreenCaptureAccess(), "inputSourceId": inputSourceID(),
            "osVersion": ProcessInfo.processInfo.operatingSystemVersionString]
}
struct Request: Decodable {
    let actionId: String
    let kind: String
    let pid: Int32
    let windowId: UInt32
    let x: Double?
    let y: Double?
    let text: String?
    let key: String?
}
enum InputError: Error { case invalid(String) }
func require(_ value: Bool, _ reason: String) throws { if !value { throw InputError.invalid(reason) } }
let characterKeys: [Character: CGKeyCode] = [
    "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,
    "q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,
    "6":22,"5":23,"9":25,"7":26,"-":27,"8":28,"0":29,"o":31,"u":32,"i":34,
    "p":35,"l":37,"j":38,"k":40,"n":45,"m":46," ":49,
]
let specialKeys: [String: CGKeyCode] = ["Enter":36,"Escape":53,"F2":120]

do {
    if CommandLine.arguments == [CommandLine.arguments[0], "--preflight"] {
        try output(["schemaVersion":1,"kind":"macos-os-input-preflight","permissions":permissions()])
        exit(0)
    }
    try require(CommandLine.arguments.count == 1, "unexpected-arguments")
    let data = FileHandle.standardInput.readDataToEndOfFile()
    try require(data.count <= 8192, "oversized-request")
    let request = try JSONDecoder().decode(Request.self, from: data)
    try require(request.actionId.range(of: "^[a-z0-9-]{1,64}$", options: .regularExpression) != nil, "invalid-action-id")
    try require(request.pid > 1 && request.windowId > 0, "invalid-target")
    try require(CGPreflightPostEventAccess(), "post-event-permission-denied")
    try require(["click","doubleClick","type","key"].contains(request.kind), "invalid-kind")
    var keys: [(CGKeyCode, CGEventFlags)] = []
    if request.kind == "type" {
        let text = request.text ?? ""
        try require(!text.isEmpty && text.utf8.count <= 64, "invalid-text")
        for character in text {
            let lower = String(character).lowercased()
            try require(lower.count == 1, "unsupported-character")
            guard let key = characterKeys[Character(lower)] else { throw InputError.invalid("unsupported-character") }
            keys.append((key, String(character) == lower ? [] : .maskShift))
        }
    } else if request.kind == "key" {
        guard let key = specialKeys[request.key ?? ""] else { throw InputError.invalid("unsupported-key") }
        keys = [(key, [])]
    }
    // Check the exact native window still belongs to the spawned application.
    guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, request.windowId) as? [[String: Any]],
          let window = windows.first,
          let owner = window[kCGWindowOwnerPID as String] as? NSNumber,
          let bounds = window[kCGWindowBounds as String] as? [String: NSNumber] else {
        throw InputError.invalid("target-window-unavailable")
    }
    try require(owner.int32Value == request.pid, "target-window-owner-changed")
    let rect = CGRect(x: bounds["X"]?.doubleValue ?? .nan, y: bounds["Y"]?.doubleValue ?? .nan,
                      width: bounds["Width"]?.doubleValue ?? .nan, height: bounds["Height"]?.doubleValue ?? .nan)
    var point: CGPoint?
    if request.kind == "click" || request.kind == "doubleClick" {
        guard let x = request.x, let y = request.y, x.isFinite, y.isFinite else { throw InputError.invalid("invalid-point") }
        point = CGPoint(x: x, y: y)
        try require(rect.contains(point!), "point-outside-target-window")
    }
    guard let application = NSRunningApplication(processIdentifier: request.pid), !application.isTerminated else {
        throw InputError.invalid("application-not-running")
    }
    application.activate(options: [.activateIgnoringOtherApps])
    let deadline = Date().addingTimeInterval(2)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != request.pid && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
    try require(NSWorkspace.shared.frontmostApplication?.processIdentifier == request.pid, "target-not-frontmost")
    guard let source = CGEventSource(stateID: .hidSystemState) else { throw InputError.invalid("event-source-unavailable") }
    var sent = 0
    func post(_ event: CGEvent?) throws {
        guard let event else { throw InputError.invalid("event-allocation-failed") }
        event.post(tap: .cghidEventTap); sent += 1
    }
    let startedAt = Date().timeIntervalSince1970 * 1000
    if let point {
        try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
        let count = request.kind == "doubleClick" ? 2 : 1
        for index in 1...count {
            for type in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
                let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
                event?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
                try post(event)
                Thread.sleep(forTimeInterval: 0.025)
            }
            if index < count { Thread.sleep(forTimeInterval: 0.075) }
        }
    } else {
        for (key, flags) in keys {
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
                event?.flags = flags
                try post(event)
                Thread.sleep(forTimeInterval: 0.025)
            }
        }
    }
    try output(["schemaVersion":1,"ok":true,"actionId":request.actionId,"kind":request.kind,
                "pid":request.pid,"windowId":request.windowId,"eventCount":sent,"startedAt":startedAt,
                "finishedAt":Date().timeIntervalSince1970 * 1000,"permissions":permissions(),
                "method":"CGEvent-hidSystemState","physicalIME":false])
} catch {
    try? output(["schemaVersion":1,"ok":false,"error":String(describing:error),"permissions":permissions()])
    exit(1)
}
