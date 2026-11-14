import ApplicationServices
import Carbon
import Cocoa
import CoreGraphics
import Vision

// Native input for recorded walkthroughs. Pacing is deliberately human:
// viewers follow a cursor that glides, settles, then clicks, and text that is
// typed at a readable rhythm.

signal(SIGPIPE, SIG_IGN)

let source = CGEventSource(stateID: .hidSystemState)

struct DesktopError: Error {
  let message: String
  var timing: KeyTiming? = nil
  init(_ message: String, timing: KeyTiming? = nil) {
    self.message = message
    self.timing = timing
  }
}

// What this helper is holding down right now, so every way out can let go of it.
// Otherwise a failed drag leaves the button down and the person's next move drags.
var heldButton = false
var heldKey: CGKeyCode? = nil
var heldModifiers: [(CGKeyCode, CGEventFlags)] = []
func releaseHeld(timing: KeyTiming? = nil) {
  var flags = heldModifiers.reduce(CGEventFlags()) { $0.union($1.1) }
  if let key = heldKey {
    heldKey = nil
    let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    if e != nil { timing?.endAtMs = nowMs() }
  }
  if heldButton {
    heldButton = false
    let at = CGEvent(source: nil)?.location ?? .zero
    CGEvent(
      mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: at, mouseButton: .left
    )?.post(tap: .cghidEventTap)
  }
  for (code, flag) in heldModifiers.reversed() {
    flags.remove(flag)
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    e?.type = .flagsChanged
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    if e != nil { timing?.endAtMs = nowMs() }
  }
  heldModifiers = []
}

func fail(_ text: String) -> Never {
  releaseHeld()
  fputs(text + "\n", stderr)
  exit(1)
}

// A timeout or Ctrl-C stops the helper mid-gesture. The main thread is asleep
// between events, so the handlers run on another queue.
var stopSignals: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)
  let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
  s.setEventHandler {
    releaseHeld()
    exit(128 + sig)
  }
  s.resume()
  stopSignals.append(s)
}

func output(_ value: Any) {
  guard let d = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
    let s = String(data: d, encoding: .utf8)
  else { fail("JSON failed") }
  print(s)
  fflush(stdout)
}

func nowMs() -> Int64 {
  Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
}

// Same wall clock as the helper's mouse and action times. These are injection
// receipts, not evidence that the application has painted a result.
final class KeyTiming {
  var onsetsMs: [Int64] = []
  var endAtMs: Int64? = nil
  var result: [String: Any] {
    ["clock": "unix-ms", "onsetsMs": onsetsMs, "endAtMs": endAtMs.map { $0 as Any } ?? NSNull()]
  }

  func posted(down: Bool) {
    if down { onsetsMs.append(nowMs()) } else { endAtMs = nowMs() }
  }
}

// Keys whose virtual key codes are the same on every keyboard layout.
let namedKeys: [String: CGKeyCode] = [
  "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
]
let modifierKeys: [String: (CGKeyCode, CGEventFlags)] = [
  "command": (55, .maskCommand), "shift": (56, .maskShift), "option": (58, .maskAlternate),
  "control": (59, .maskControl),
]

// Letters and punctuation come from the person's keyboard layout, not US key
// positions: on AZERTY the US "a" key is Q, so Cmd+A sent by position quits the
// app. Input methods without a key layout (Japanese, Chinese) fall back to the
// ASCII layout macOS itself uses for shortcuts.
func layoutData(named id: String? = nil) -> CFData? {
  let inputs =
    id.map {
      (TISCreateInputSourceList([kTISPropertyInputSourceID: $0] as CFDictionary, true)?
        .takeRetainedValue() as? [TISInputSource] ?? []).map(Optional.some)
    } ?? [
      TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
    ]
  for case let input? in inputs {
    if let raw = TISGetInputSourceProperty(input, kTISPropertyUnicodeKeyLayoutData) {
      return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
    }
  }
  return nil
}

let mainKeys = Array(0..<65) + Array(93..<128)
let keypadKeys = Array(65...92)
func keyCode(
  for character: String, modifierState: UInt32, in data: CFData, keys: [Int] = mainKeys,
  caseSensitive: Bool = false
) -> CGKeyCode? {
  guard let bytes = CFDataGetBytePtr(data) else { return nil }
  let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
  for code in keys {
    var dead: UInt32 = 0
    var length = 0
    var chars = [UniChar](repeating: 0, count: 4)
    let status = UCKeyTranslate(
      layout, UInt16(code), UInt16(kUCKeyActionDown), modifierState, UInt32(LMGetKbdType()),
      OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
    guard status == noErr, length > 0 else { continue }
    let produced = String(utf16CodeUnits: chars, count: length)
    if caseSensitive ? (produced == character) : (produced.lowercased() == character) {
      return CGKeyCode(code)
    }
  }
  return nil
}

/** The key code to press for a key name, and the modifiers to hold with it. */
func resolveKey(_ name: String, _ modifiers: [String], layout: String? = nil) throws -> (
  CGKeyCode, [String]
) {
  for m in modifiers where modifierKeys[m] == nil {
    throw DesktopError("Unsupported modifier: \(m)")
  }
  if let code = namedKeys[name] { return (code, modifiers) }
  guard name.count == 1 else { throw DesktopError("Unsupported key: \(name)") }
  guard let data = layoutData(named: layout) else {
    throw DesktopError("Cannot read the keyboard layout")
  }
  // Layouts like "Dvorak - QWERTY ⌘" move keys while Command is held.
  let command = modifiers.contains("command") ? UInt32(cmdKey >> 8) : 0
  if let code = keyCode(for: name, modifierState: command, in: data) { return (code, modifiers) }
  // A character that needs Shift on this layout (digits on AZERTY), pressed on its own.
  if modifiers.isEmpty, let code = keyCode(for: name, modifierState: UInt32(shiftKey >> 8), in: data) {
    return (code, ["shift"])
  }
  if let code = keyCode(for: name, modifierState: command, in: data, keys: keypadKeys) {
    return (code, modifiers)
  }
  throw DesktopError("Key \(name) is not on the current keyboard layout")
}

/** Resolve a typed character to its physical key code and modifiers so keystroke recorders see real key codes. */
func resolveTypeKey(_ ch: Character, in data: CFData?) -> (CGKeyCode, [String])? {
  if ch == "\n" || ch == "\r" || ch == "\r\n" { return (namedKeys["return"]!, []) }
  if ch == "\t" { return (namedKeys["tab"]!, []) }
  if ch == " " { return (namedKeys["space"]!, []) }
  guard let data = data else { return nil }
  let s = String(ch)
  let combos: [([String], UInt32)] = [
    ([], 0),
    (["shift"], UInt32(shiftKey >> 8)),
    (["option"], UInt32(optionKey >> 8)),
    (["shift", "option"], UInt32((shiftKey | optionKey) >> 8)),
  ]
  for (mods, state) in combos {
    if let code = keyCode(for: s, modifierState: state, in: data, caseSensitive: true) {
      return (code, mods)
    }
  }
  return nil
}

// Apps an agent may not drive or screenshot: terminals (typed commands run),
// password managers and system security UI. SCREENSTUDIO_ALLOW_APPS (bundle
// ids, comma separated) opens one up, e.g. for a command-line demo.
let excludedApps: Set<String> = [
  "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty", "io.alacritty", "co.zeit.hyper", "com.github.wez.wezterm",
  "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
  "com.lastpass.LastPass", "com.dashlane.Dashlane", "com.apple.Passwords", "com.apple.keychainaccess",
  "com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.ScreenContinuity",
]

func allowedApps() -> Set<String> {
  Set(
    (ProcessInfo.processInfo.environment["SCREENSTUDIO_ALLOW_APPS"] ?? "").split(separator: ",").map {
      $0.trimmingCharacters(in: .whitespaces)
    })
}

func ms(_ v: Double) { usleep(useconds_t(max(0, v) * 1000)) }

// Pace multiplier from the caller: 1 is natural, 1.5 is slower and calmer.
let defaultPace = Double(ProcessInfo.processInfo.environment["SCREENSTUDIO_PACE"] ?? "1") ?? 1

// Where this helper last put the pointer. If the pointer is somewhere else
// before the next step, the person moved the mouse: stop and hand it back.
var lastPointer: CGPoint? = nil
func checkPointerUnmoved() throws {
  guard let last = lastPointer, let now = CGEvent(source: nil)?.location else { return }
  if hypot(now.x - last.x, now.y - last.y) > 12 {
    throw DesktopError("Stopped: you moved the mouse. Inspect again to continue.")
  }
}

func post(_ event: CGEvent?) throws {
  guard let event = event else { throw DesktopError("Cannot create input event") }
  event.post(tap: .cghidEventTap)
}

func mouse(_ type: CGEventType, _ p: CGPoint, clicks: Int = 1) throws {
  let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
  e?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
  try post(e)
  heldButton = type == .leftMouseDown
}

func backingScaleFactor(for bounds: CGRect) -> Double {
  var display: CGDirectDisplayID = 0
  var count: UInt32 = 0
  let center = CGPoint(x: bounds.midX, y: bounds.midY)
  if CGGetDisplaysWithPoint(center, 1, &display, &count) == .success, count > 0 {
    for screen in NSScreen.screens {
      if let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
        num.uint32Value == display
      {
        return Double(screen.backingScaleFactor)
      }
    }
  }
  return Double(NSScreen.main?.backingScaleFactor ?? 1)
}

struct TargetWindow {
  let id: UInt32
  let pid: Int32
  let bounds: CGRect
  let title: String
  let app: AXUIElement

  static func resolve(windowId id: UInt32) throws -> TargetWindow {
    let windows =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    guard let window = windows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }),
      let pid = window[kCGWindowOwnerPID as String] as? Int32,
      let raw = window[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: raw)
    else { throw DesktopError("Target window is no longer on screen") }
    let title = window[kCGWindowName as String] as? String ?? ""
    let allowed = allowedApps()
    if let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
      excludedApps.contains(bundle), !allowed.contains(bundle)
    {
      throw DesktopError(
        "\(bundle) is excluded from input and screenshots by default. To allow it, set SCREENSTUDIO_ALLOW_APPS=\(bundle) in the MCP server's environment."
      )
    }
    return TargetWindow(
      id: id, pid: pid, bounds: bounds, title: title, app: AXUIElementCreateApplication(pid))
  }

  func focusedDetails() -> [String: Any] {
    guard AXIsProcessTrusted(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    else { return [:] }
    var rawElement: CFTypeRef?
    AXUIElementCopyAttributeValue(
      AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute as CFString, &rawElement)
    guard let rawElement = rawElement, CFGetTypeID(rawElement) == AXUIElementGetTypeID() else {
      return [:]
    }
    let element = rawElement as! AXUIElement
    func attribute(_ name: String) -> String {
      var value: CFTypeRef?
      AXUIElementCopyAttributeValue(element, name as CFString, &value)
      return value as? String ?? ""
    }
    let subrole = attribute(kAXSubroleAttribute)
    return [
      "role": attribute(kAXRoleAttribute), "label": attribute(kAXTitleAttribute),
      "value": subrole == "AXSecureTextField" ? "[protected]" : attribute(kAXValueAttribute),
    ]
  }

  func inspectResult() -> [String: Any] {
    let pointer = CGEvent(source: nil)?.location ?? .zero
    return [
      "windowId": id, "pid": pid, "title": title,
      "bounds": [
        "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height,
      ], "focusedElement": focusedDetails(), "accessibility": AXIsProcessTrusted(),
      "frontmost": frontmostPid() == pid,
      "pointer": ["x": pointer.x - bounds.origin.x, "y": pointer.y - bounds.origin.y],
    ]
  }

  func boundsResult() -> [String: Any] {
    return [
      "windowId": id,
      "pid": pid,
      "title": title,
      "bounds": [
        "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height,
      ],
      "backingScaleFactor": backingScaleFactor(for: bounds),
    ]
  }

  func requireTrust() throws {
    guard AXIsProcessTrusted() else {
      throw DesktopError(
        "Enable Accessibility for the desktop helper in macOS Settings, then inspect the target again"
      )
    }
  }

  func matches(_ ax: AXUIElement) -> Bool {
    var p: CFTypeRef?
    var s: CFTypeRef?
    AXUIElementCopyAttributeValue(ax, kAXPositionAttribute as CFString, &p)
    AXUIElementCopyAttributeValue(ax, kAXSizeAttribute as CFString, &s)
    guard let p = p, let s = s, CFGetTypeID(p) == AXValueGetTypeID(),
      CFGetTypeID(s) == AXValueGetTypeID()
    else { return false }
    var point = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return abs(point.x - bounds.origin.x) < 2 && abs(point.y - bounds.origin.y) < 2
      && abs(size.width - bounds.width) < 2 && abs(size.height - bounds.height) < 2
  }

  // Asked of Accessibility each time: NSWorkspace only updates its frontmost app
  // when the main run loop runs, which it does not while input is being sent.
  func frontmostPid() -> pid_t? {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value)
        == .success,
      let value = value, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    var focusedPid: pid_t = 0
    AXUIElementGetPid(value as! AXUIElement, &focusedPid)
    return focusedPid
  }

  /** The target app is frontmost and its focused window is the observed one. */
  func isFocused() -> Bool {
    // The app's own AXFrontmost answers even when the system-wide focused-app
    // query cannot complete (it fails while two copies of a browser run).
    var front: CFTypeRef?
    let asked = AXUIElementCopyAttributeValue(app, kAXFrontmostAttribute as CFString, &front)
    if asked == .success, let isFront = front as? Bool {
      guard isFront else { return false }
    } else {
      guard frontmostPid() == pid else { return false }
    }
    var now: CFTypeRef?
    AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &now)
    guard let now = now, CFGetTypeID(now) == AXUIElementGetTypeID() else { return false }
    return matches(now as! AXUIElement)
  }

  func focus() throws -> [String: Any] {
    try requireTrust()
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    let candidates = (value as? [AXUIElement] ?? []).filter(matches)
    guard candidates.count == 1 else {
      throw DesktopError("Cannot uniquely match the target window for focus")
    }
    AXUIElementPerformAction(candidates[0], kAXRaiseAction as CFString)
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    for i in 1...20 {
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
      if isFocused() { return ["focused": true] }
      if i == 5 {
        // macOS can decline activation asked by a background process; Accessibility usually works.
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(candidates[0], kAXMainAttribute as CFString, kCFBooleanTrue)
      }
    }
    throw DesktopError(
      "Could not bring the target window to the front (macOS declined activation). Click the window once or bring it forward, then inspect again"
    )
  }

  func assertInitialFocus() throws {
    try requireTrust()
    guard isFocused() else {
      throw DesktopError("Focus changed. Inspect and focus the target before acting")
    }
  }

  func assertFocus() throws {
    if !isFocused() {
      throw DesktopError("Focus changed during input. Inspect the target again")
    }
  }

  // Clicks and scrolls land on whatever window is topmost at the point, so check
  // nothing covers the target there: a notification, a floating panel, a control
  // bar. Fully transparent windows, the menu bar, screen-sized overlays (such as
  // a recorder's click-through layer) and the target app's own open menu (the
  // next click picks from it) are not in the way.
  func screenArea(at p: CGPoint) -> CGFloat {
    var display: CGDirectDisplayID = 0
    var count: UInt32 = 0
    CGGetDisplaysWithPoint(p, 1, &display, &count)
    let screen = count > 0 ? CGDisplayBounds(display) : .zero
    return screen.width * screen.height
  }

  func isClickThroughScreenStudioOverlay(_ w: [String: Any], at p: CGPoint) -> Bool {
    let owner = w[kCGWindowOwnerName as String] as? String
    let name = w[kCGWindowName as String] as? String
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    let sharing = w[kCGWindowSharingState as String] as? Int ?? -1
    guard owner == "Screen Studio", name == "Screen Studio", layer == 105, sharing == 0,
      let coverPid = w[kCGWindowOwnerPID as String] as? Int32
    else { return false }
    var hit: AXUIElement?
    guard
      AXUIElementCopyElementAtPosition(
        AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success,
      let el = hit
    else { return false }
    var hitPid: pid_t = 0
    AXUIElementGetPid(el, &hitPid)
    if hitPid != 0 && hitPid != coverPid { return true }
    guard hitPid == pid else { return false }
    var hitWin: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXWindowAttribute as CFString, &hitWin) == .success,
      let win = hitWin, CFGetTypeID(win) == AXUIElementGetTypeID()
    else { return false }
    return matches(win as! AXUIElement)
  }

  func assertUncovered(_ p: CGPoint) throws {
    let above =
      CGWindowListCopyWindowInfo(
        [.optionOnScreenAboveWindow, .excludeDesktopElements], CGWindowID(id)) as? [[String: Any]]
      ?? []
    let passThrough: Set<Int> = [
      Int(CGWindowLevelForKey(.mainMenuWindow)), Int(CGWindowLevelForKey(.statusWindow)),
      Int(CGWindowLevelForKey(.cursorWindow)),
    ]
    let menu = Int(CGWindowLevelForKey(.popUpMenuWindow))
    for w in above {
      let layer = w[kCGWindowLayer as String] as? Int ?? 0
      let owner = w[kCGWindowOwnerName as String] as? String ?? "another window"
      // Screen Studio 4.1.0 keeps a non-capturable click-through overlay at layer 105; exempt it only when hit-testing passes through.
      if isClickThroughScreenStudioOverlay(w, at: p) { continue }
      guard (w[kCGWindowAlpha as String] as? Double ?? 1) > 0, !passThrough.contains(layer),
        !(layer == menu && w[kCGWindowOwnerPID as String] as? Int32 == pid),
        let raw = w[kCGWindowBounds as String] as? NSDictionary,
        let r = CGRect(dictionaryRepresentation: raw), r.contains(p),
        r.width * r.height < screenArea(at: p) * 0.9
      else { continue }
      throw DesktopError(
        "The target is covered at that point by \(owner). Move it away, then inspect again")
    }
  }

  func point(_ x: Double, _ y: Double) throws -> CGPoint {
    guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < bounds.width, y < bounds.height else {
      throw DesktopError("Coordinates must be inside the target window")
    }
    return CGPoint(x: bounds.origin.x + x, y: bounds.origin.y + y)
  }

  // Glide along a gentle arc. Duration grows with distance, like a person's hand.
  func move(
    _ target: CGPoint, dragging: Bool = false, durationMs: Double? = nil, pace: Double = defaultPace
  ) throws {
    try checkPointerUnmoved()
    let initial = CGEvent(source: nil)?.location ?? target
    lastPointer = initial
    let dx = target.x - initial.x
    let dy = target.y - initial.y
    let distance = hypot(dx, dy)
    if distance < 1 { return }
    if let explicit = durationMs, explicit <= 0 {
      try assertFocus()
      try checkPointerUnmoved()
      try post(
        CGEvent(
          mouseEventSource: source, mouseType: dragging ? .leftMouseDragged : .mouseMoved,
          mouseCursorPosition: target, mouseButton: .left))
      lastPointer = target
      return
    }
    let duration =
      durationMs ?? (min(1100, max(420, 380 + Double(distance) * 0.45)) * pace)
    let steps = max(4, Int(duration / 8))
    let bend = min(Double(distance) * 0.08, 36) * (dx >= 0 ? 1 : -1)
    let nx = distance > 0 ? -Double(dy) / Double(distance) : 0
    let ny = distance > 0 ? Double(dx) / Double(distance) : 0
    for i in 1...steps {
      try assertFocus()
      try checkPointerUnmoved()
      let t = Double(i) / Double(steps)
      let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
      let arc = sin(Double.pi * t) * bend
      let p = CGPoint(
        x: Double(initial.x) + Double(dx) * eased + nx * arc,
        y: Double(initial.y) + Double(dy) * eased + ny * arc)
      try post(
        CGEvent(
          mouseEventSource: source, mouseType: dragging ? .leftMouseDragged : .mouseMoved,
          mouseCursorPosition: p, mouseButton: .left))
      lastPointer = p
      ms(duration / Double(steps))
    }
  }

  func press(_ name: String, _ requested: [String], timing: KeyTiming) throws {
    let (key, modifiers) = try resolveKey(name, requested)
    if modifiers.contains("command") && ["q", "w", "h", "m", "tab", "space", "`", "escape"].contains(name.lowercased()) {
      throw DesktopError("System and window-management shortcuts are not sent")
    }
    try checkPointerUnmoved()
    try sendKeyCombo(
      key: key, modifiers: modifiers, modDelayMs: 45, downMs: 70, upMs: 40, timing: timing)
  }

  func sendKeyCombo(
    key: CGKeyCode, modifiers: [String], modDelayMs: Double, downMs: Double, upMs: Double,
    timing: KeyTiming, checkFocusBeforeDown: Bool = true
  ) throws {
    var flags: CGEventFlags = []
    for m in modifiers {
      let (code, flag) = modifierKeys[m]!
      flags.insert(flag)
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
      e?.type = .flagsChanged
      e?.flags = flags
      try post(e)
      heldModifiers.append((code, flag))
      if modDelayMs > 0 { ms(modDelayMs) }
    }
    // Focus is checked before the key goes down only: a shortcut like Cmd+N moves
    // focus itself, and its key-up must still be sent.
    if checkFocusBeforeDown { try assertFocus() }
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
      e?.flags = flags
      try post(e)
      timing.posted(down: down)
      heldKey = down ? key : nil
      ms(down ? downMs : upMs)
    }
    for m in modifiers.reversed() {
      let (code, flag) = modifierKeys[m]!
      flags.remove(flag)
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
      e?.type = .flagsChanged
      e?.flags = flags
      try post(e)
      timing.endAtMs = nowMs()
      heldModifiers.removeLast()
      if modDelayMs > 0 { ms(modDelayMs) }
    }
  }

  func typeText(
    _ text: String, perCharMs: Double? = nil, pace: Double = defaultPace, timing: KeyTiming
  ) throws {
    guard text.utf16.count <= 2000 else { throw DesktopError("Text is too long") }
    if let perCharMs = perCharMs, perCharMs < 0 {
      throw DesktopError("perCharMs must be >= 0")
    }
    // About 12 characters a second with small variation: readable, not robotic.
    var rng = SystemRandomNumberGenerator()
    let data = layoutData()
    try checkPointerUnmoved()
    lastPointer = CGEvent(source: nil)?.location
    for char in text {
      try assertFocus()
      try checkPointerUnmoved()
      var delay: Double
      if let explicit = perCharMs {
        delay = explicit
      } else {
        delay = 60.0 + Double(UInt8.random(in: 0...40, using: &rng))
        if char == " " { delay += 35 }
        if ".,!?:;".contains(char) { delay += 90 }
        delay *= pace
      }
      if let (code, mods) = resolveTypeKey(char, in: data) {
        let downHold = perCharMs != nil ? min(18.0, max(4.0, delay * 0.35)) : 25.0
        let modDelay = perCharMs != nil ? 0.0 : 12.0
        try sendKeyCombo(
          key: code, modifiers: mods, modDelayMs: modDelay, downMs: downHold, upMs: 0, timing: timing)
        ms(max(0, delay - downHold))
      } else {
        let utf16 = Array(String(char).utf16)
        let downHold = perCharMs != nil ? min(18.0, max(4.0, delay * 0.35)) : 25.0
        for down in [true, false] {
          guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
            throw DesktopError("Key event failed")
          }
          e.flags = []
          utf16.withUnsafeBufferPointer {
            e.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: $0.baseAddress)
          }
          try post(e)
          timing.posted(down: down)
          heldKey = down ? 0 : nil
          if down { ms(downHold) }
        }
        ms(max(0, delay - downHold))
      }
    }
  }
}

func hideApp(bundleId: String) -> [String: Any] {
  let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
  let pids = Set(apps.map { $0.processIdentifier })
  func visibleWindows() -> Int {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return windows.filter { w in
      pids.contains(w[kCGWindowOwnerPID as String] as? Int32 ?? 0)
        && (w[kCGWindowLayer as String] as? Int ?? 0) == 0
        && (w[kCGWindowAlpha as String] as? Double ?? 1) > 0
    }.count
  }
  for app in apps {
    _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXHiddenAttribute as CFString, kCFBooleanTrue)
    _ = app.hide()
  }
  for _ in 0..<20 {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    if visibleWindows() == 0 { break }
  }
  let visible = visibleWindows()
  return ["bundleId": bundleId, "hidden": !apps.isEmpty && visible == 0, "matchedCount": apps.count, "visibleWindowCount": visible]
}

func settleHiddenApp(bundleId: String) -> [String: Any] {
  let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
  guard !apps.isEmpty else { return ["settled": false, "reason": "app-not-running"] }
  let pids = Set(apps.map { $0.processIdentifier })
  func windows() -> [[String: Any]] {
    let all = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return all.filter { pids.contains($0[kCGWindowOwnerPID as String] as? Int32 ?? 0) }
  }
  let baseline = Set(windows().filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { $0[kCGWindowNumber as String] as? UInt32 })
  let start = nowMs()
  let pointer = CGEvent(source: nil)?.location ?? .zero
  let events = CGEventType(rawValue: UInt32.max)!
  var quietSince = start
  var rehides = 0
  _ = hideApp(bundleId: bundleId)
  while nowMs() - start < 10000 {
    let elapsed = nowMs() - start
    let idleMs = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: events) * 1000
    let currentPointer = CGEvent(source: nil)?.location ?? pointer
    if idleMs + 100 < Double(elapsed) || hypot(currentPointer.x - pointer.x, currentPointer.y - pointer.y) > 2 {
      return ["settled": false, "reason": "desktop-input-during-startup"]
    }
    let shown = windows().filter { ($0[kCGWindowIsOnscreen as String] as? Bool ?? false) && ($0[kCGWindowAlpha as String] as? Double ?? 1) > 0 }
    if shown.isEmpty && apps.allSatisfy({ $0.isHidden }) {
      if elapsed >= 6000 && nowMs() - quietSince >= 1500 {
        return ["settled": true, "rehides": rehides, "elapsedMs": elapsed]
      }
    } else {
      let editors = Set(shown.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { $0[kCGWindowNumber as String] as? UInt32 })
      var frontmost: CFTypeRef?
      var frontPid: pid_t = 0
      if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &frontmost) == .success,
        let app = frontmost, CFGetTypeID(app) == AXUIElementGetTypeID() {
        AXUIElementGetPid(app as! AXUIElement, &frontPid)
      }
      guard rehides < 1, elapsed < 6000, !pids.contains(frontPid), editors.isSubset(of: baseline) else {
        return ["settled": false, "reason": "unexpected-screenstudio-window-or-focus"]
      }
      _ = hideApp(bundleId: bundleId)
      rehides += 1
      quietSince = nowMs()
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  }
  return ["settled": false, "reason": "startup-timeout"]
}

func executeWindowAction(_ action: String, _ params: [String: Any]) throws -> [String: Any] {
  if action == "capabilities" { return ["protocolVersion": 1, "splitButtons": true, "expectedTarget": true] }
  if action == "hide-app" {
    let bundleId = (params["bundleId"] as? String) ?? "com.timpler.screenstudio"
    return hideApp(bundleId: bundleId)
  }
  if action == "settle-hidden-app" {
    return settleHiddenApp(bundleId: (params["bundleId"] as? String) ?? "com.timpler.screenstudio")
  }
  guard let widRaw = params["windowId"],
    let wid = (widRaw as? UInt32) ?? (widRaw as? Int).flatMap({ $0 >= 0 ? UInt32($0) : nil })
  else {
    throw DesktopError("Invalid window ID")
  }
  let target = try TargetWindow.resolve(windowId: wid)
  if let expected = params["expect"] as? [String: Any] {
    guard let pid = expected["pid"] as? Int, pid == Int(target.pid),
      let b = expected["bounds"] as? [String: Double],
      b["x"] == target.bounds.origin.x, b["y"] == target.bounds.origin.y,
      b["width"] == target.bounds.width, b["height"] == target.bounds.height
    else { throw DesktopError("Target window changed; native input stopped") }
  }
  if action == "inspect" { return target.inspectResult() }
  if action == "bounds" { return target.boundsResult() }
  if action == "focus" { return try target.focus() }

  let pace = (params["pace"] as? Double) ?? defaultPace
  try target.assertInitialFocus()

  var extra: [String: Any] = [:]

  func num(_ key: String) throws -> Double {
    if let v = params[key] as? Double { return v }
    if let v = params[key] as? Int { return Double(v) }
    throw DesktopError("Missing numeric parameter: \(key)")
  }
  func optNum(_ key: String) -> Double? {
    if let v = params[key] as? Double { return v }
    if let v = params[key] as? Int { return Double(v) }
    return nil
  }

  switch action {
  case "move":
    let p = try target.point(try num("x"), try num("y"))
    try target.move(p, durationMs: optNum("durationMs"), pace: pace)
    extra["atMs"] = nowMs()
  case "down":
    let p = try target.point(try num("x"), try num("y"))
    try target.assertFocus()
    try checkPointerUnmoved()
    try target.assertUncovered(p)
    let t = nowMs()
    try mouse(.leftMouseDown, p)
    lastPointer = p
    extra["atMs"] = t
    extra["downAtMs"] = t
  case "up":
    let p = try target.point(try num("x"), try num("y"))
    try target.assertFocus()
    try checkPointerUnmoved()
    let t = nowMs()
    try mouse(.leftMouseUp, p)
    lastPointer = p
    extra["atMs"] = t
    extra["upAtMs"] = t
  case "click", "doubleClick":
    let p = try target.point(try num("x"), try num("y"))
    let settleMs = optNum("settleMs") ?? (200 * pace)
    let durationMs = optNum("durationMs")
    try target.move(p, durationMs: durationMs, pace: pace)
    if settleMs > 0 { ms(settleMs) }
    var firstDown: Int64 = 0
    var lastUp: Int64 = 0
    for n in 1...(action == "doubleClick" ? 2 : 1) {
      try target.assertFocus()
      try checkPointerUnmoved()
      try target.assertUncovered(p)
      let d = nowMs()
      if n == 1 { firstDown = d }
      try mouse(.leftMouseDown, p, clicks: n)
      ms(85)
      try mouse(.leftMouseUp, p, clicks: n)
      lastUp = nowMs()
      if n == 1 && action == "doubleClick" { ms(90) }
    }
    extra["downAtMs"] = firstDown
    extra["upAtMs"] = lastUp
  case "taps":
    let p = try target.point(try num("x"), try num("y"))
    guard let count = (params["count"] as? Int) ?? (params["count"] as? Double).map(Int.init),
      let every = optNum("intervalMs"), (1...80).contains(count), every >= 30, every <= 2000
    else { throw DesktopError("taps needs count 1-80 and intervalMs 30-2000") }
    try target.move(p, durationMs: optNum("durationMs"), pace: pace)
    ms(150 * pace)
    let firstDown = nowMs()
    for _ in 0..<count {
      try target.assertFocus()
      try checkPointerUnmoved()
      try target.assertUncovered(p)
      try mouse(.leftMouseDown, p)
      ms(min(45, every / 2))
      try mouse(.leftMouseUp, p)
      ms(every - min(45, every / 2))
    }
    extra["downAtMs"] = firstDown
    extra["upAtMs"] = nowMs()
  case "hold":
    let p = try target.point(try num("x"), try num("y"))
    guard let hold = optNum("ms"), hold >= 50, hold <= 15000 else {
      throw DesktopError("hold needs ms 50-15000")
    }
    try target.move(p, durationMs: optNum("durationMs"), pace: pace)
    ms(150 * pace)
    try target.assertFocus()
    try checkPointerUnmoved()
    try target.assertUncovered(p)
    let downAt = nowMs()
    try mouse(.leftMouseDown, p)
    var held = 0.0
    while held < hold {
      let step = min(50, hold - held)
      ms(step)
      held += step
      try target.assertFocus()
      try checkPointerUnmoved()
    }
    try mouse(.leftMouseUp, p)
    extra["downAtMs"] = downAt
    extra["upAtMs"] = nowMs()
  case "drag":
    let from = try target.point(try num("x"), try num("y"))
    let to = try target.point(try num("toX"), try num("toY"))
    try target.move(from, durationMs: optNum("durationMs"), pace: pace)
    ms(200 * pace)
    try target.assertFocus()
    try checkPointerUnmoved()
    try target.assertUncovered(from)
    try target.assertUncovered(to)
    let downAt = nowMs()
    try mouse(.leftMouseDown, from)
    ms(150)
    try target.move(to, dragging: true, durationMs: optNum("dragDurationMs"), pace: pace)
    ms(150)
    try mouse(.leftMouseUp, to)
    extra["downAtMs"] = downAt
    extra["upAtMs"] = nowMs()
  case "type", "key":
    let startAt = nowMs()
    let timing = KeyTiming()
    do {
      if action == "type" {
        guard let text = params["text"] as? String else { throw DesktopError("Missing text") }
        try target.typeText(text, perCharMs: optNum("perCharMs"), pace: pace, timing: timing)
      } else {
        guard let keyName = params["key"] as? String else { throw DesktopError("Missing key") }
        let mods = (params["modifiers"] as? [String]) ?? []
        if keyName == "selectAll" {
          try target.press("a", ["command"], timing: timing)
        } else {
          try target.press(keyName, mods, timing: timing)
        }
      }
    } catch {
      releaseHeld(timing: timing)
      let message = (error as? DesktopError)?.message ?? error.localizedDescription
      throw DesktopError(message, timing: timing)
    }
    extra["atMs"] = startAt
    for (k, v) in timing.result { extra[k] = v }
  case "scroll":
    guard let linesRaw = (params["lines"] as? Int) ?? (params["lines"] as? Double).map(Int.init),
      abs(linesRaw) <= 100
    else { throw DesktopError("Invalid scroll amount") }
    let lines = Int32(linesRaw)
    // Scroll events go to the window under the pointer, not the focused one, so
    // put the pointer over the target first: the given point, where it already
    // rests inside the content, or the middle of the content below the title bar.
    let titleBar: CGFloat = target.bounds.height > 120 ? 28 : 0
    let content = CGRect(
      x: target.bounds.minX, y: target.bounds.minY + titleBar, width: target.bounds.width,
      height: target.bounds.height - titleBar)
    let resting = CGEvent(source: nil)?.location ?? .zero
    let anchor: CGPoint
    if params["x"] != nil && params["y"] != nil {
      anchor = try target.point(try num("x"), try num("y"))
    } else if content.contains(resting) {
      anchor = resting
    } else {
      anchor = CGPoint(x: content.midX, y: content.midY)
    }
    try target.move(anchor, durationMs: optNum("durationMs"), pace: pace)
    // Spread the distance over many small pixel steps so the page glides.
    let total = Double(lines) * 40
    let steps = max(10, min(60, Int(abs(total) / 12)))
    var sent = 0.0
    let startAt = nowMs()
    for i in 1...steps {
      try target.assertFocus()
      try checkPointerUnmoved()
      guard let at = CGEvent(source: nil)?.location, target.bounds.contains(at) else {
        throw DesktopError(
          "The pointer left the target window during the scroll. Inspect the target again")
      }
      try target.assertUncovered(at)
      let t = Double(i) / Double(steps)
      let targetPos = total * (1 - pow(1 - t, 3))
      let delta = (targetPos - sent).rounded()
      sent += delta
      let e = CGEvent(
        scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(delta),
        wheel2: 0, wheel3: 0)
      e?.location = at
      try post(e)
      lastPointer = at
      ms(16 * pace)
    }
    extra["atMs"] = startAt
    extra["endAtMs"] = nowMs()
  default:
    throw DesktopError("Unsupported action")
  }
  var res: [String: Any] = ["action": action, "windowId": target.id, "performed": true]
  for (k, v) in extra { res[k] = v }
  return res
}

let args = CommandLine.arguments

// Permission check for the installer's doctor: no window needed.
if args.count >= 2 && args[1] == "trust" {
  // With "prompt", macOS shows its own permission requests for the app this runs under.
  if args.count == 3 && args[2] == "prompt" {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  }
  output(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])
  exit(0)
}

if args.count >= 2 && args[1] == "hide-app" {
  output(hideApp(bundleId: args.count >= 3 ? args[2] : "com.timpler.screenstudio"))
  exit(0)
}
if args.count >= 2 && args[1] == "settle-hidden-app" {
  output(settleHiddenApp(bundleId: args.count >= 3 ? args[2] : "com.timpler.screenstudio"))
  exit(0)
}

if args.count >= 2 && args[1] == "--stdio" {
  while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    var reqId: Any = NSNull()
    do {
      guard let data = trimmed.data(using: .utf8),
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        throw DesktopError("Invalid JSON request; expected {action, ...}")
      }
      if let idVal = obj["id"] { reqId = idVal }
      guard let action = obj["action"] as? String else { throw DesktopError("Missing action") }
      let result = try executeWindowAction(action, obj)
      output(["id": reqId, "ok": true, "result": result])
    } catch let err as DesktopError {
      releaseHeld()
      lastPointer = nil
      var response: [String: Any] = ["id": reqId, "ok": false, "error": err.message]
      if let timing = err.timing { response["result"] = timing.result }
      output(response)
    } catch {
      releaseHeld()
      lastPointer = nil
      output(["id": reqId, "ok": false, "error": error.localizedDescription])
    }
  }
  releaseHeld()
  exit(0)
}

if args.count < 3 { fail("Expected action and window ID, or ocr and image paths") }
let action = args[1]

// Report which key a name maps to, without pressing anything: on the current
// layout, or on an installed one named like com.apple.keylayout.French.
if action == "resolve-key" {
  do {
    let (code, modifiers) = try resolveKey(
      args[2], args.count > 3 ? args[3].split(separator: ",").filter { !$0.isEmpty }.map(String.init) : [],
      layout: args.count > 4 ? args[4] : nil)
    output(["keyCode": code, "modifiers": modifiers])
    exit(0)
  } catch let err as DesktopError {
    fail(err.message)
  }
}

if action == "resolve-type-key" {
  guard args[2].count == 1, let ch = args[2].first else { fail("Expected single character") }
  let data = layoutData(named: args.count > 3 ? args[3] : nil)
  if let (code, modifiers) = resolveTypeKey(ch, in: data) {
    output(["resolved": true, "keyCode": code, "modifiers": modifiers])
  } else {
    output(["resolved": false])
  }
  exit(0)
}

// Read the text in still images with Apple's Vision, for finding private data
// in recorded frames: one JSON line per text line, boxes 0-1 with a top-left
// origin. Words (split at spaces and punctuation like = : , ; quotes and
// brackets) carry UTF-16 offsets into the line, so a match inside a line
// can be boxed on its own. Language correction is off: it "fixes" tokens.
if action == "ocr" {
  func topLeft(_ r: CGRect) -> [String: Double] {
    ["x": Double(r.minX), "y": Double(1 - r.maxY), "width": Double(r.width), "height": Double(r.height)]
  }
  for (index, file) in args.dropFirst(2).enumerated() {
    guard let image = NSImage(contentsOfFile: file),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { fail("Cannot read image \(file)") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
    do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request]) } catch {
      fail("Text recognition failed for \(file): \(error.localizedDescription)")
    }
    for observation in request.results ?? [] {
      guard let best = observation.topCandidates(1).first else { continue }
      let text = best.string
      var words: [[String: Any]] = []
      var start: String.Index? = nil
      for i in text.indices + [text.endIndex] {
        let blank = i == text.endIndex || text[i].isWhitespace || "=:,;\"'()<>[]{}".contains(text[i])
        if !blank, start == nil { start = i }
        guard blank, let s = start else { continue }
        start = nil
        if let box = try? best.boundingBox(for: s..<i) {
          words.append([
            "start": text.utf16.distance(from: text.startIndex, to: s),
            "end": text.utf16.distance(from: text.startIndex, to: i),
            "box": topLeft(box.boundingBox),
          ])
        }
      }
      output([
        "image": index, "text": text, "confidence": Double(best.confidence),
        "box": topLeft(observation.boundingBox), "words": words,
      ])
    }
  }
  exit(0)
}

// Locate an on-screen window by exact title (used to find an editor window).
if action == "find-title" {
  let windows =
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
  let matches = windows.filter { ($0[kCGWindowName as String] as? String) == args[2] }
  guard matches.count == 1, let id = matches[0][kCGWindowNumber as String] as? UInt32 else {
    fail("Window not found on screen. Bring the editor window on screen and try again.")
  }
  output(["windowId": id])
  exit(0)
}

func cliParams() -> [String: Any] {
  guard let wid = UInt32(args[2]) else { fail("Invalid window ID") }
  var params: [String: Any] = ["windowId": wid]
  switch action {
  case "inspect", "bounds", "focus":
    break
  case "move":
    guard args.count >= 5, let x = Double(args[3]), let y = Double(args[4]) else {
      fail("Coordinates must be inside the target window")
    }
    params["x"] = x
    params["y"] = y
    if args.count >= 6, let d = Double(args[5]) { params["durationMs"] = d }
  case "down", "up":
    fail("Split mouse buttons require a persistent --stdio session")
  case "click", "doubleClick":
    guard args.count >= 5, let x = Double(args[3]), let y = Double(args[4]) else {
      fail("Coordinates must be inside the target window")
    }
    params["x"] = x
    params["y"] = y
    if args.count >= 6, let s = Double(args[5]), s >= 0 { params["settleMs"] = s }
    if args.count >= 7, let d = Double(args[6]) { params["durationMs"] = d }
  case "taps":
    guard args.count >= 7, let x = Double(args[3]), let y = Double(args[4]),
      let count = Int(args[5]), let every = Double(args[6])
    else { fail("taps needs count 1-80 and intervalMs 30-2000") }
    params["x"] = x
    params["y"] = y
    params["count"] = count
    params["intervalMs"] = every
  case "hold":
    guard args.count >= 6, let x = Double(args[3]), let y = Double(args[4]),
      let hold = Double(args[5])
    else { fail("hold needs ms 50-15000") }
    params["x"] = x
    params["y"] = y
    params["ms"] = hold
  case "drag":
    guard args.count >= 7, let x = Double(args[3]), let y = Double(args[4]),
      let toX = Double(args[5]), let toY = Double(args[6])
    else { fail("Coordinates must be inside the target window") }
    params["x"] = x
    params["y"] = y
    params["toX"] = toX
    params["toY"] = toY
  case "type":
    guard args.count == 4 || args.count == 5 else { fail("Expected text for type") }
    guard args[3].utf16.count <= 2000 else { fail("Text is too long") }
    params["text"] = args[3]
    if args.count == 5, let perChar = Double(args[4]) { params["perCharMs"] = perChar }
  case "key":
    guard args.count >= 4 else { fail("Missing key") }
    params["key"] = args[3]
    params["modifiers"] =
      args.count > 4 ? args[4].split(separator: ",").map(String.init) : []
  case "scroll":
    guard args.count == 4 || args.count == 6, let lines = Int(args[3]) else {
      fail("Invalid scroll amount")
    }
    params["lines"] = lines
    if args.count == 6, let x = Double(args[4]), let y = Double(args[5]) {
      params["x"] = x
      params["y"] = y
    }
  default:
    fail("Unsupported action")
  }
  return params
}

do {
  let result = try executeWindowAction(action, cliParams())
  output(result)
} catch let err as DesktopError {
  if let timing = err.timing { output(timing.result) }
  fail(err.message)
} catch {
  fail(error.localizedDescription)
}
