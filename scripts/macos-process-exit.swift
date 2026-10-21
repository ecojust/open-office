// Diagnostic-only read-only process exit observer, extracted from the previously exercised helper.
import Darwin
import Foundation
func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
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

exit(1)
