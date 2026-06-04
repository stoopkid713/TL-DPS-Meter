"""Catch old-brand teal/purple stragglers the prior hex-only rebrand sweep missed
(rgb-tuple forms + the secondary violet ramp + dark shades). Map to Night & Brick +.
Hex case-insensitive; rgb tuples only inside rgb()/rgba(); alpha preserved.
Run from repo root: python backend/tools/_brand_stragglers.py
"""
import re, glob, os

HEX = {
    "22d3ee": "D96444",  # teal       -> brick
    "0891b2": "B5492E",  # dark cyan  -> brick-dark
    "a78bfa": "5B92D4",  # violet-400 -> sky
    "a855f7": "5B92D4",  # purple-500 -> sky
    "8b5cf6": "5B92D4",  # violet-500 -> sky
    "7c3aed": "3F6FA8",  # violet-700 -> sky-dark
}
RGB = {
    (34, 211, 238):  (217, 100, 68),   # teal   -> brick
    (167, 139, 250): (91, 146, 212),   # violet -> sky
    (168, 85, 247):  (91, 146, 212),   # purple -> sky
    (139, 92, 246):  (91, 146, 212),   # violet -> sky
}

def sweep(text):
    n = 0
    for old, new in HEX.items():
        text, c = re.compile("#" + old, re.IGNORECASE).subn("#" + new, text); n += c
    for (r, g, b), (nr, ng, nb) in RGB.items():
        pat = re.compile(r"(rgba?\(\s*)%d(\s*,\s*)%d(\s*,\s*)%d\b" % (r, g, b), re.IGNORECASE)
        text, c = pat.subn(lambda m, nr=nr, ng=ng, nb=nb:
                           "%s%d%s%d%s%d" % (m.group(1), nr, m.group(2), ng, m.group(3), nb), text); n += c
    return text, n

def main():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    files = [os.path.join(root, "index.html")] + sorted(glob.glob(os.path.join(root, "src", "js", "*.js")))
    total = 0
    for f in files:
        with open(f, encoding="utf-8") as fh: src = fh.read()
        out, n = sweep(src)
        if n:
            with open(f, "w", encoding="utf-8") as fh: fh.write(out)
            total += n; print("%5d  %s" % (n, os.path.relpath(f, root)))
    print("---\n%5d  TOTAL" % total)

if __name__ == "__main__":
    main()
