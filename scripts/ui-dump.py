#!/usr/bin/env python3
"""Parse an Android UIAutomator dump XML into JSON element list.
Usage: python3 ui-dump.py XMLFILE [--query SUBSTRING] [--max N]
Prints JSON: {"summary": str, "elements": [ {text, resourceId, contentDesc, class,
  bounds:[l,t,r,b], center:[cx,cy], clickable, enabled, visible, important} ... ]}
Only nodes with meaningful content are returned (text/contentDesc/resource-id,
clickable, or accessibility-important).
"""
import json
import re
import sys
from xml.etree import ElementTree as ET


def parse_bounds(b):
    nums = [int(n) for n in re.findall(r'\d+', b)]
    if len(nums) != 4:
        return None
    return nums
def main():
    path = sys.argv[1]
    query = None
    maxn = 25
    i = 2
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == "--query":
            query = sys.argv[i + 1]; i += 2
        elif arg == "--max":
            maxn = int(sys.argv[i + 1]); i += 2
        else:
            i += 1

    root = ET.parse(path).getroot()
    elements = []
    for node in root.iter("node"):
        attrs = node.attrib
        text = (attrs.get("text") or "").strip()
        content_desc = (attrs.get("content-desc") or "").strip()
        resource_id = attrs.get("resource-id", "")
        cls = attrs.get("class", "")
        bounds = attrs.get("bounds", "0,0,0,0")
        parts = parse_bounds(bounds)
        if parts is None:
            continue
        l, t, r, b = parts
        visible = attrs.get("visible", "false").lower() == "true"
        clickable = attrs.get("clickable", "false").lower() == "true"
        enabled = attrs.get("enabled", "false").lower() == "true"
        focused = attrs.get("focused", "false").lower() == "true"
        selected = attrs.get("selected", "false").lower() == "true"
        important = attrs.get("importantForAccessibility", "").lower() == "true"
        hint = attrs.get("hint", "").strip()
        center = ((l + r) // 2, (t + b) // 2)
        elements.append({
            "text": text,
            "contentDesc": content_desc,
            "resourceId": resource_id,
            "class": cls,
            "bounds": [l, t, r, b],
            "center": center,
            "clickable": clickable,
            "enabled": enabled,
            "visible": visible,
            "focused": focused,
            "selected": selected,
            "hint": hint,
            "important": important,
        })

    def matches(e):
        if not query:
            return True
        q = query.lower()
        return (q in e["text"].lower() or q in e["contentDesc"].lower() or
                q in e["resourceId"].lower() or q in e["class"].lower() or
                q in e["hint"].lower())

    def interesting(e):
        return e["text"] or e["contentDesc"] or e["resourceId"] or e["clickable"] or e["important"] or e["focused"]

    kept = [e for e in elements if interesting(e)]
    shown = [e for e in kept if matches(e)]
    summary = (
        f"{len(elements)} elements in tree; {len(kept)} interesting; "
        f"{len(shown)} match (query={query!r}, shown up to {maxn})"
    )
    print(json.dumps({"summary": summary, "elements": shown[:maxn]}))

if __name__ == "__main__":
    main()
