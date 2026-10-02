#!/usr/bin/env python3
"""Extract the Khala-relevant CSS verbatim from the design HTML (by line ranges)."""
import sys
src, out = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().split("\n")
# 1-based inclusive ranges, verified by reading the source.
ranges = [
    (16, 153, "tokens (dark default + warm-sand light), base element rules, .mono/.num, links, buttons"),
    (226, 244, ".tool-btn + .toggle-icon (theme toggle chrome)"),
    (246, 271, "cards + .status-badge (+ Live) + @keyframes pulse"),
    (1189, 1190, ".section-card"),
    (413, 771, "Khala (.kh-*) incl. admin/ownership block and @media 1100/900/760 + container queries"),
    (1763, 1763, "@media (max-width:480px) .section-card padding/radius (shared)"),
]
buf = ["/* Verbatim extract from 'source/Aiur Dashboard.html' (sha256 5242159e...). Do not edit; regenerate. */"]
for a, b, label in ranges:
    buf.append(f"\n/* ==== lines {a}-{b}: {label} ==== */")
    chunk = lines[a - 1:b]
    if a == 1763:
        chunk = ["@media (max-width: 480px) {"] + chunk + ["}"]
    buf.extend(chunk)
open(out, "w", encoding="utf-8").write("\n".join(buf) + "\n")
print("wrote", out, sum(b - a + 1 for a, b, _ in ranges), "lines")
