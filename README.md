# mcp-phone-use

MCP stdio server that controls an attached **Android phone** over ADB — the phone twin of `mcp-computer-use`.

```
~/.pi/agent/mcp.json  ->  bun /workspace/mcp-phone-use/server.coffee
```

## The simple interface

| Tool | What it does | Image? |
|---|---|---|
| `phone_screenshot` | Capture screen; `crop {x,y,width,height}` + `grid` to zoom | yes |
| `phone_click` | Tap at x,y in the last image's pixels | yes (unless `observe:false`) |
| `phone_type` | Type text into the focused field (`enter:true` to submit) | yes |
| `phone_key` | Send a key, a chord (`Ctrl+A`), a sequence (`Ctrl+A,Delete`), `repeat:N` | yes |
| `phone_find_element` | Substring search over the live UI tree + tap centers | **no** |
| `phone_ui_dump` | Live uiautomator tree (text, resource-id, content-desc, class, bounds, center, `focused`) | **no** |
| `phone_info` | serial / model / android / screen px | no |
| `phone_clear_text` | Clear a field (Ctrl+A+Delete, else long-press → Select all → Cut) | **no** |
| `phone_long_press`, `phone_swipe`, `phone_interact` | long press, swipe, ordered tap→text→keys | yes |
| `phone_keyboard` | escape hatch: status / attach / detach of the virtual keyboard | no |

## Virtual HID keyboard (the important part)

`phone_type` and `phone_key` send **real keystrokes** on a **virtual HID keyboard** the server creates and manages itself. Callers never attach or detach it.

How it works (all verified on a real device running Android 17, no root, no USB gadget, no BlueZ):

* Android ships `/system/bin/hid` (`frameworks/base/cmds/hid`), which writes `UHID_CREATE2` to `/dev/uhid` through `libhidcommand_jni`.
* adb's `shell` uid is in the `uhid` group: `uid=2000(shell) ... groups=...,3011(uhid),...` and `/dev/uhid` is `crw-rw---- uhid uhid`. SELinux is `Enforcing` and it still works.
* `adb shell hid -` is kept alive with a pseudo-JSON stdin stream (`register` → `delay` → `report`), which creates a genuine input device: `/dev/input/event4`, `Classes: KEYBOARD | EXTERNAL`, visible in `dumpsys input`, `getevent` shows `KEY_LEFTCTRL`/`KEY_A` with `MSC_SCAN 000700e0`.
* Because it is a *physical* keyboard to the OS, hardware-keyboard semantics work: **Ctrl+A select-all**, Ctrl+C/V/X, Tab, Escape, normal typing.

Measured comparison on the same field:

| Method | Ctrl+A select-all | Typing | Notes |
|---|---|---|---|
| `input keycombination 113 29` (adb chord) | ✗ typed a literal `a` | ✓ | API-level injection; apps ignore the injected meta |
| `input keyevent 67` | n/a | one key | works, but no modifiers |
| **virtual HID keyboard** | **✓** (Ctrl+A then Delete wiped the whole field; Ctrl+C → Delete → Ctrl+V pasted it back) | **✓** (incl. `@` as Shift+2) | real device, real meta state |

### The one gotcha: VID/PID

Use a VID/PID with **no** `/system/usr/keylayout/Vendor_XXXX_Product_YYYY.kl`, otherwise EventHub maps our HID usages through that vendor layout and *every key silently does nothing*. The first attempt used a well-known vendor pair (`18d1:2c40`) that ships on the tested device as a remote-control layout — keys reached the kernel and `InputReader` (`KeyState (pressed): KEY_LEFTCTRL, KEY_A`) but nothing reached the app. Default is now `vid=0x1234 pid=0x9999` → falls back to `Generic.kl` (US layout).

### Lifecycle

* Attached implicitly by the first `phone_key` / `phone_type` / `phone_clear_text`.
* Auto-detaches after `idleMs` (default 240 s) so the phone does not keep a phantom keyboard.
* Killed on `SIGINT`/`SIGTERM`; closing the `hid` process' stdin unregisters the device (EOF → unregister).
* If `/dev/uhid` is denied (locked-down OEM builds), the server silently falls back to `input text` / `input keyevent` / `input keycombination`.

## Screenshot-quota loop

1. Read/locate with `phone_find_element` / `phone_ui_dump` — **text only, no image**.
2. Send input with `observe:false` — no screenshot returned; `phone_key`/`phone_type`/`phone_clear_text` need no `screenshotId`.
3. Batch: `phone_key { keys:"Delete", repeat:25, observe:false }` = 25 backspaces, **one** call.
4. Screenshot only when you must see pixels (or need a `screenshotId` for coordinate taps).

## Android 17 quirks (measured)

* `input long-press` **does not exist** (`Unknown command: long-press`) → long press = zero-distance swipe with duration: `input swipe X Y X Y 1200`.
* `input keyevent` accepts key names; `input keycombination [-t ms] <codes...>` is the chord API but its meta state is ignored by most apps.
* uiautomator bounds are `bounds="[l,t][r,b]"` (bracketed pairs) — `scripts/ui-dump.py` handles both; it also reports `focused`/`selected`.
* `KEYCODE_CTRL_LEFT` is **113** (not 291). HID side: left-ctrl is modifier bit `0x01`, `A` is usage `0x04`, Left-Arrow is `0x50` (verified by cursor-position test).

## Layout

```
server.coffee          tool definitions + JSON-RPC wiring
shared/mcp-stdio.mjs   minimal newline-delimited MCP stdio host
lib/adb.mjs            device resolution, screencap/pull, uiautomator dump, shell, spawnShell
lib/hidkbd.mjs         virtual HID keyboard: UHID register/report, HID usage tables, idle auto-detach
lib/phone.mjs          taps, long-press, text, keys, clear_text, ui dump (HID preferred, adb fallback)
lib/views.mjs          screenshotId registry (120s TTL), crop/point mapping, geometry guard
lib/schema.mjs         tiny JSON-Schema subset validator
scripts/screenshot-view.py  crop/scale/grid (Pillow)
scripts/ui-dump.py     XML -> JSON elements
```

## Run

```bash
bun /workspace/mcp-phone-use/server.coffee   # stdio MCP server (also launched from mcp.json)
pi mcp list                                  # validate the mcp.json entry
```

Requires `adb` and `python3` + Pillow (`requirements.txt`). Multiple devices: set `ADB_SERIAL=<serial>`.
