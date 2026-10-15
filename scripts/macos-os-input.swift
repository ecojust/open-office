// Diagnostic-only OS input. No AppleEvents, System Events, clipboard or DOM injection.
import AppKit
import ApplicationServices
import Carbon
import Darwin
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

// This mode only observes one already identified process. kqueue checks the
// caller's existing permission to obtain exit status; it does not send a signal
// or require task_for_pid / debugger attachment. It never activates an app.
func observeExit(pid: Int32, timeoutMs: Int) throws {
    let began = ProcessInfo.processInfo.systemUptime
    func emit(_ event: String, _ extra: [String: Any] = [:]) throws {
        var value: [String: Any] = ["schemaVersion":1,"kind":"macos-process-exit","event":event,
            "pid":pid,"source":"EVFILT_PROC","unixMs":Date().timeIntervalSince1970 * 1000,
            "elapsedMs":(ProcessInfo.processInfo.systemUptime - began) * 1000]
        value.merge(extra) { _, new in new }
        try output(value)
        fflush(stdout)
    }
    func failure(_ stage: String, _ code: Int32) throws {
        let blocked = code == EACCES || code == EPERM || code == ESRCH
        let reason = code == EACCES || code == EPERM ? "permission-denied"
            : code == ESRCH ? "target-absent-before-registration" : stage
        try emit(blocked ? "blocked" : "failed", ["reason":reason,"errno":code,"stage":stage])
    }
    let queue = kqueue()
    guard queue >= 0 else { try failure("kqueue-failed", errno); return }
    defer { close(queue) }
    // A closed stdin or a byte from our parent ends this observer only.
    let inputFlags = fcntl(STDIN_FILENO, F_GETFL)
    guard inputFlags >= 0 && fcntl(STDIN_FILENO, F_SETFL, inputFlags | O_NONBLOCK) == 0 else {
        try failure("control-channel-failed", errno); return
    }
    var change = kevent(ident: UInt(pid), filter: Int16(EVFILT_PROC),
        flags: UInt16(EV_ADD | EV_ENABLE | EV_ONESHOT | EV_RECEIPT),
        fflags: UInt32(NOTE_EXIT) | UInt32(NOTE_EXITSTATUS) | UInt32(NOTE_EXIT_DETAIL), data: 0, udata: nil)
    var receipt = kevent()
    var immediate = timespec(tv_sec: 0, tv_nsec: 0)
    let registered = kevent(queue, &change, 1, &receipt, 1, &immediate)
    guard registered >= 0 else { try failure("registration-failed", errno); return }
    guard registered == 1 && receipt.flags & UInt16(EV_ERROR) != 0 else {
        try emit("failed", ["reason":"missing-registration-receipt"]); return
    }
    guard receipt.data == 0 else { try failure("registration-failed", Int32(receipt.data)); return }
    try emit("registered")
    let deadline = began + Double(timeoutMs) / 1000
    while ProcessInfo.processInfo.systemUptime < deadline {
        var byte: UInt8 = 0
        let readCount = read(STDIN_FILENO, &byte, 1)
        if readCount >= 0 { try emit("stopped"); return }
        if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
            try failure("control-read-failed", errno); return
        }
        let remaining = max(0, min(0.2, deadline - ProcessInfo.processInfo.systemUptime))
        var wait = timespec(tv_sec: 0, tv_nsec: Int(remaining * 1_000_000_000))
        var event = kevent()
        let count = kevent(queue, nil, 0, &event, 1, &wait)
        if count < 0 {
            if errno == EINTR { continue }
            try failure("observation-failed", errno); return
        }
        if count == 0 { continue }
        guard event.ident == UInt(pid) && event.filter == Int16(EVFILT_PROC) else {
            try emit("failed", ["reason":"unexpected-process-event"]); return
        }
        if event.flags & UInt16(EV_ERROR) != 0 {
            try failure("process-event-error", Int32(event.data)); return
        }
        guard event.fflags & UInt32(NOTE_EXIT) != 0 else { continue }
        let raw = UInt32(truncatingIfNeeded: event.data)
        let available = event.fflags & UInt32(NOTE_EXITSTATUS) != 0
        let status = raw & 0xffff
        let signal = status & 0x7f
        var details: [String: Any] = ["rawData":Int64(event.data),"flags":event.flags,"fflags":event.fflags,
            "waitStatusAvailable":available,"detailAvailable":event.fflags & UInt32(NOTE_EXIT_DETAIL) != 0]
        if available {
            details["waitStatus"] = status
            details["exitedNormally"] = signal == 0
            details["signaled"] = signal != 0 && signal != 0x7f
            if signal == 0 { details["exitCode"] = (status >> 8) & 0xff }
            if signal != 0 && signal != 0x7f {
                details["signal"] = signal
                details["coreDumped"] = status & 0x80 != 0
            }
        }
        if event.fflags & UInt32(NOTE_EXIT_DETAIL) != 0 {
            details["detailFlags"] = raw & UInt32(NOTE_EXIT_DETAIL_MASK)
            details["memoryExit"] = raw & UInt32(NOTE_EXIT_MEMORY) != 0
            details["codeSigningExit"] = raw & UInt32(NOTE_EXIT_CSERROR) != 0
            details["decryptFailure"] = raw & UInt32(NOTE_EXIT_DECRYPTFAIL) != 0
        }
        try emit("exited", details)
        return
    }
    try emit("timeout", ["reason":"observation-deadline"])
}

if CommandLine.arguments.dropFirst().first == "--observe-exit" {
    // Keep observation failures out of the input-mode catch, which queries
    // accessibility and screen capture permissions solely for actual inputs.
    do {
        let args = CommandLine.arguments
        try require(args.count == 5 && args[3] == "--timeout-ms", "invalid-observer-arguments")
        guard let pid = Int32(args[2]), let timeout = Int(args[4]) else { throw InputError.invalid("invalid-observer-target") }
        try require(pid > 1 && pid != getpid() && timeout >= 100 && timeout <= 180000, "invalid-observer-bounds")
        try observeExit(pid: pid, timeoutMs: timeout)
        exit(0)
    } catch {
        try? output(["schemaVersion":1,"kind":"macos-process-exit","event":"failed","reason":"observer-invalid-or-unavailable"])
        fflush(stdout)
        exit(1)
    }
}

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
