#!/usr/bin/env bun
# Phone-use MCP: control an attached Android phone over ADB.
# Tools: screenshot, tap, long-press, type, key, swipe, interact, UI dump, find element, info.
import { runMcpStdioServer, textResult } from './shared/mcp-stdio.mjs'
import { createAdb } from './lib/adb.mjs'
import { createPhone } from './lib/phone.mjs'
import { createHidKeyboard } from './lib/hidkbd.mjs'
import { renderView, createViews } from './lib/views.mjs'

adb = createAdb()
# Virtual HID keyboard (adb-only, no root): attached implicitly on the first type/key call,
# auto-detaches when idle. Callers never manage it.
hid = createHidKeyboard { adb }
phone = createPhone { adb, render: renderView, views: createViews(), hid }

schema = (properties, required = []) ->
  { type: 'object', additionalProperties: false, properties, required }

snapshotProp =
  type: 'string'
  minLength: 1
  description: 'Exact screenshotId from the latest phone_screenshot/observation result. IDs expire after 120 seconds or any input action.'

pixelProp =
  type: 'integer'
  minimum: 0
  description: 'Pixel coordinate in the referenced IMAGE; no offsets.'

actionProps =
  screenshotId: snapshotProp
  waitMs:
    type: 'integer'
    minimum: 0
    maximum: 2000
    default: 500
    description: 'Pause after input before the result observation.'

tapProps =
  x: pixelProp
  y: pixelProp

longPressProps = Object.assign({}, tapProps,
  durationMs:
    type: 'integer'
    minimum: 200
    maximum: 10000
    default: 1500
    description: 'Long-press duration in ms.'
)

textProp =
  type: 'string'
  minLength: 1
  maxLength: 4000
  description: 'Literal text to send into the FOCUSED field (tap it first with phone_click/interact if needed).'

keysProp =
  type: 'string'
  minLength: 1
  maxLength: 200
  description: 'One key, a chord, or a comma-separated sequence, sent as REAL keystrokes on a virtual HID keyboard the server attaches automatically: "Enter", "Escape", "Tab", "Delete", "Backspace", "Space", "a-z", "0-9", "F1"-"F12", "Up/Down/Left/Right", "Home", "End", "PageUp", "PageDown", "Insert", "Menu", "CapsLock". Chords use + with the modifier first: "Ctrl+A" (select all), "Ctrl+C", "Ctrl+V", "Ctrl+X", "Alt+Tab", "Shift+Tab", "Meta+D". Commas make a sequence: "Ctrl+A,Delete". Numeric keycodes (66, 4) also work on the fallback path.'

enterProp =
  type: 'boolean'
  default: false
  description: 'Press Enter (real keystroke) after the text.'

repeatProp =
  type: 'integer'
  minimum: 1
  maximum: 100
  default: 1
  description: 'Repeat the key/sequence N times in ONE call (e.g. keys:"Delete", repeat:20 = 20 backspaces, one round-trip, no extra screenshots).'

observeProp =
  type: 'boolean'
  default: true
  description: 'false = do NOT return a screenshot after the action (saves image quota). Verify with phone_ui_dump instead. Keys/text without coordinates also work with no screenshotId at all.'

swipeProps = Object.assign({},
  fromX: pixelProp
  fromY: pixelProp
  toX: pixelProp
  toY: pixelProp
  durMs:
    type: 'integer'
    minimum: 50
    maximum: 5000
    default: 300
    description: 'Swipe duration in ms.'
)

tools =
  phone_screenshot:
    description: "Capture the phone screen as an image. Returns screenshotId, device info, and a PNG. To zoom in, pass the returned screenshotId plus crop {x,y,width,height} in that image's pixels (and/or grid: true). Coordinates used by actions are in the returned IMAGE, top-left (0,0)."
    inputSchema: schema(Object.assign({},
      screenshotId: snapshotProp
      crop:
        type: 'object'
        additionalProperties: false
        required: ['x', 'y', 'width', 'height']
        properties:
          x: pixelProp
          y: pixelProp
          width: pixelProp
          height: pixelProp
      maxWidth:
        type: 'integer'
        minimum: 320
        maximum: 2000
        default: 1280
      grid:
        type: 'boolean'
        default: false
    ))
    handler: (args = {}) -> phone.screenshot args

  phone_info:
    description: 'Device info: serial, model, Android version, screen width/height in device pixels. Non-destructive.'
    inputSchema:
      type: 'object'
      properties: {}
    handler: ->
      info = await phone.info()
      textResult JSON.stringify(info, null, 1)

  phone_ui_dump:
    description: "Dump the current screen's live UI hierarchy (uiautomator) and list interesting elements with text, resource-id, content-desc, bounds and center (device pixels). Non-destructive; useful to find what to tap."
    inputSchema:
      type: 'object'
      properties: {}
    handler: -> phone.uiDump()

  phone_find_element:
    description: "Search the current screen's UI hierarchy for a substring (in text, content-desc, resource-id or class) and return matching elements with tap coordinates (center in device pixels)."
    inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 200, description: 'Substring to search for.' } }, ['query'])
    handler: (args = {}) -> phone.findElement(args.query)

  phone_click:
    description: 'Tap the CENTER of a target in a returned screenshot. Pass its screenshotId and x,y in IMAGE pixels; do not add or subtract any offsets. Returns a fresh full-screen screenshot; inspect it. If the tap does nothing, the target may need to be focused first.'
    inputSchema: schema(Object.assign({}, actionProps, tapProps, { observe: observeProp }), ['screenshotId', 'x', 'y'])
    handler: (args = {}) -> phone.tap args

  phone_long_press:
    description: 'Long-press a target (for context menus, drag starts, etc.). Returns a fresh screenshot.'
    inputSchema: schema(Object.assign({}, actionProps, longPressProps, { observe: observeProp }), ['screenshotId', 'x', 'y'])
    handler: (args = {}) -> phone.longPress args

  phone_type:
    description: 'Type text into the focused field as real keystrokes (the server attaches a virtual HID keyboard automatically; no IME needed). No screenshotId needed. Returns a fresh screenshot unless observe:false; verify with phone_find_element.'
    inputSchema: schema(Object.assign({}, actionProps, { text: textProp, enter: enterProp, observe: observeProp }), ['text'])
    handler: (args = {}) -> phone.type args

  phone_key:
    description: 'Send keys as real keystrokes on the automatically-attached virtual HID keyboard: single keys (Enter, Escape, Tab, Delete, Space, arrows, Home/End, F1-F12), chords ("Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Alt+Tab", "Shift+Tab"), comma sequences ("Ctrl+A,Delete"), and repeat:N to press N times in ONE call. No screenshotId needed. Ctrl+A select-all genuinely works here, unlike adb input keyevent/keycombination. Returns a fresh screenshot unless observe:false.'
    inputSchema: schema(Object.assign({}, actionProps, { keys: keysProp, repeat: repeatProp, observe: observeProp }), ['keys'])
    handler: (args = {}) -> phone.key args

  phone_keyboard:
    description: 'Rarely needed: inspect or force the virtual HID keyboard that the server manages automatically (status / attach / detach). Keys and text attach it implicitly and it auto-detaches when idle. Use detach only if the phone must stop seeing a physical keyboard right away (e.g. the user wants the on-screen keyboard back).'
    inputSchema:
      type: 'object'
      additionalProperties: false
      properties:
        action:
          type: 'string'
          enum: ['status', 'attach', 'detach']
          default: 'status'
    handler: (args = {}) ->
      switch args.action
        when 'attach' then textResult JSON.stringify(await phone.keyboard.attach(), null, 1)
        when 'detach' then textResult JSON.stringify(phone.keyboard.detach('manual'), null, 1)
        else textResult JSON.stringify(phone.keyboard.status(), null, 1)

  phone_clear_text:
    description: 'Clear a text field. Preferred path: Ctrl+A then Delete on the virtual HID keyboard (real select-all). If that does not clear it, falls back to the touch selection toolbar (long-press -> "Select all" -> "Cut"). Auto-targets the focused editable field, or pass x,y of the field in image pixels. Returns text-only before/after verification and takes NO screenshot.'
    inputSchema: schema(Object.assign({},
      screenshotId: Object.assign({}, snapshotProp, { description: 'Optional: the screenshot whose pixels x,y refer to. Omit x,y to auto-target the focused editable field.' })
      x: pixelProp
      y: pixelProp
      durationMs:
        type: 'integer'
        minimum: 400
        maximum: 4000
        default: 1200
        description: 'Long-press duration in ms.'
      observe: observeProp
    ))
    handler: (args = {}) -> phone.clearText args

  phone_swipe:
    description: 'Swipe from (fromX,fromY) to (toX,toY) in IMAGE pixels (scroll, drag, dismiss). Returns a fresh screenshot.'
    inputSchema: schema(Object.assign({}, actionProps, swipeProps, { observe: observeProp }), ['screenshotId', 'fromX', 'fromY', 'toX', 'toY'])
    handler: (args = {}) -> phone.swipe args

  phone_interact:
    description: 'Ordered compound action on one screenshot: optional tap/long-press (x,y[,durationMs]) then optional text then optional keys (chord/sequence, repeat:N) — or a swipe. Use this to tap a field and type in one round-trip. Never batch a separate phone_click and phone_type in parallel; use phone_interact. Returns a fresh screenshot unless observe:false.'
    inputSchema: schema(Object.assign({}, actionProps, tapProps, longPressProps, { text: textProp, keys: keysProp, repeat: repeatProp, enter: enterProp, observe: observeProp }, swipeProps), ['screenshotId'])
    handler: (args = {}) ->
      if (args.x is undefined) and (args.text is undefined) and (args.keys is undefined) and (args.fromX is undefined)
        return textResult 'Provide at least a tap, long-press, text, keys, or swipe', true
      phone.interact args

instructions =
  "phone-use MCP for the attached Android phone. Cheapest loop: phone_ui_dump / phone_find_element (text only, no image) to locate targets and read field contents; phone_screenshot only when you must SEE the screen. Actions return a fresh screenshot — pass observe:false to skip it when you can verify with phone_ui_dump instead (image quota). For coordinates, use x,y in the LAST returned image's pixels (no offsets). phone_type/phone_key need no screenshotId (no coordinates) and are sent as REAL keystrokes on a virtual HID keyboard the server attaches automatically (adb-only, no root): Ctrl+A select-all, Ctrl+C/V/X, Tab and Escape behave like a physical keyboard, so never try to manage that keyboard yourself. keys accepts names, chords (Ctrl+A), comma sequences and repeat:N for many presses in one call; phone_type accepts enter:true. To clear a field use phone_clear_text (Ctrl+A+Delete, falling back to long-press -> Select all -> Cut). Android 17 has no `input long-press` command: long press is a zero-distance swipe with a duration. Input delivery does not prove the app acted on it — verify."

await runMcpStdioServer
  name: 'phone-use'
  version: '0.1.0'
  instructions: instructions
  tools: tools
