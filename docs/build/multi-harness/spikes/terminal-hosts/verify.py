#!/usr/bin/env python3
"""Check each harness emptyPrompt pattern against its tmux captures.

Each capture is a .cursorline file: line 1 is "cursor_x=N cursor_y=M", line 2 is the
cursor line from `tmux capture-pane -p -S y -E y`. The guard: strip trailing ASCII spaces,
match the regex, and require cursor_x == column where the input starts (prompt column).
"""
import pathlib, re, sys

CAP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).parent)

# (regex, input-start column rule)
PATTERNS = {
    "claude":   (r'^❯[\u00a0 ]?(Try ".*")?$',                       lambda l: 2),
    "codex":    (r'^› ?(Ask Codex to do anything)?$',             lambda l: 2),
    "gemini":   (r'^ > {3}Type your message or @path/to/file$|^ > $', lambda l: 3),
    "opencode": (r'^ *┃ *(Ask anything\.\.\. ".*")?$',           lambda l: l.index("┃") + 3),
    "copilot":  (r'^❯ ?$',                                       lambda l: 2),
    "agy":      (r'^> ?$',                                       lambda l: 2),
    "muse":     (r'^❯ ?$',                                       lambda l: 2),
}
EXPECT = {"empty": True, "after-turn": True, "draft": False, "space": False, "draft-home": False, "draft-session": False, "empty-rotated": True}

fails = 0
for h, (rx, col) in PATTERNS.items():
    for f in sorted(CAP.glob(f"{h}-*.cursorline")):
        state = f.stem[len(h) + 1:]
        if state not in EXPECT:
            continue
        head, line = f.read_text().split("\n", 1)
        line = line.rstrip("\n").rstrip(" ")
        x = int(head.split()[0].split("=")[1])
        m = re.match(rx, line) is not None
        ok = m and x == col(line) if "┃" in line or h != "opencode" else m
        got = bool(ok)
        verdict = "ok" if got == EXPECT[state] else "MISMATCH"
        if verdict != "ok":
            fails += 1
        print(f"{h:9} {state:11} x={x:<3} regex={'y' if m else 'n'} empty={'y' if got else 'n'} expect={'y' if EXPECT[state] else 'n'} {verdict}  [{line.strip()[:50]}]")
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
