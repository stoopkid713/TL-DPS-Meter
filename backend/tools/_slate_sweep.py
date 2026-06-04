"""One-shot: retone the Tailwind-slate skeleton to the Night & Brick + palette.
Hex replaced case-insensitively. RGB tuples replaced ONLY inside rgb()/rgba(...)
so plain JS number sequences are never touched. Alpha is preserved.
Run from repo root: python backend/tools/_slate_sweep.py
"""
import re, glob, os

# hex(lower) -> target hex (uppercase, brand convention)
HEX = {
    "0f172a": "080C14",  # slate-900 -> Midnight (bg)
    "1e293b": "111B2E",  # slate-800 -> Navy Lift (card)
    "334155": "182436",  # slate-700 -> Navy Border
    "475569": "384E74",  # slate-600 -> Navy Dim
    "64748b": "7A8CB8",  # slate-500 -> Slate+ (muted)
    "94a3b8": "7A8CB8",  # slate-400 -> Slate+ (collapse)
    "cbd5e1": "F0EBE0",  # slate-300 -> Newsprint (text)
    "e2e8f0": "F0EBE0",  # slate-200 -> Newsprint (text)
    "1a1a2e": "080C14",  # leftover body-gradient stop
}

# old rgb tuple -> new rgb tuple (matched only inside rgb/rgba)
RGB = {
    (15, 23, 42):   (8, 12, 20),
    (30, 41, 59):   (17, 27, 46),
    (51, 65, 85):   (24, 36, 54),
    (71, 85, 105):  (56, 78, 116),
    (100, 116, 139):(122, 140, 184),
    (148, 163, 184):(122, 140, 184),
}

def sweep(text):
    n = 0
    for old, new in HEX.items():
        pat = re.compile("#" + old, re.IGNORECASE)
        text, c = pat.subn("#" + new, text)
        n += c
    for (r, g, b), (nr, ng, nb) in RGB.items():
        # capture the rgba?( prefix + the comma-spacing, replace only the 3 numbers
        pat = re.compile(
            r"(rgba?\(\s*)%d(\s*,\s*)%d(\s*,\s*)%d\b" % (r, g, b),
            re.IGNORECASE,
        )
        text, c = pat.subn(lambda m, nr=nr, ng=ng, nb=nb:
                           "%s%d%s%d%s%d" % (m.group(1), nr, m.group(2), ng, m.group(3), nb),
                           text)
        n += c
    return text, n

def main():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    files = [os.path.join(root, "index.html")] + sorted(glob.glob(os.path.join(root, "src", "js", "*.js")))
    total = 0
    for f in files:
        with open(f, encoding="utf-8") as fh:
            src = fh.read()
        out, n = sweep(src)
        if n:
            with open(f, "w", encoding="utf-8") as fh:
                fh.write(out)
            total += n
            print("%5d  %s" % (n, os.path.relpath(f, root)))
    print("---\n%5d  TOTAL replacements" % total)

if __name__ == "__main__":
    main()
