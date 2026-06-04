"""L3 lightness lift (+9% bg/card/border, +5% dim) on the Night & Brick + structural
navies. Re-tones the L0 sweep output to the level Kyle picked from the ladder.
Hex case-insensitive; rgb tuples only inside rgb()/rgba(); alpha preserved.
Run from repo root: python backend/tools/_l3_lift.py
"""
import re, glob, os

HEX = {
    "080c14": "152035",  # bg     Midnight   -> +9%
    "111b2e": "1D2F50",  # card   Navy Lift  -> +9%
    "182436": "263956",  # border Navy Border-> +9%
    "384e74": "405A85",  # dim    Navy Dim   -> +5%
}
RGB = {
    (8, 12, 20):    (21, 32, 53),
    (17, 27, 46):   (29, 47, 80),
    (24, 36, 54):   (38, 57, 86),
    (56, 78, 116):  (64, 90, 133),
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
