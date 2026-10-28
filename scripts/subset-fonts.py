"""Rebuild UI font subsets from licensed originals kept OUTSIDE the extension.

Usage: python scripts/subset-fonts.py /path/to/original-fonts
Requires fonttools[woff]. Run again whenever fixed UI copy changes.
Dynamic page titles and user input fall back to the system font for other glyphs.
"""
from pathlib import Path
import string
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
# UI plus backend messages displayed by the popup. Reports are exported documents.
SOURCES = ('popup.js', 'export.js', 'video.js', 'sw.js', 'offscreen.js')

def required_characters():
    characters = set(string.ascii_letters + string.digits + string.punctuation + ' ')
    for name in SOURCES:
        characters.update(c for c in (ROOT / name).read_text() if ord(c) >= 128 and not c.isspace())
    characters.discard('✓')  # Chrome draws the toolbar badge using its own font.
    return ''.join(sorted(characters))

def main():
    originals = Path(sys.argv[1])
    characters = required_characters()
    print(f'{len(characters)} required characters')
    for weight in ('55-Regular', '75-SemiBold'):
        source = originals / f'AlibabaPuHuiTi-3-{weight}.ttf'
        target = ROOT / 'fonts' / f'AlibabaPuHuiTi-3-{weight}.subset.woff2'
        options = subset.Options()
        options.flavor = 'woff2'
        options.name_IDs = ['*']  # Retain font attribution and license metadata.
        font = subset.load_font(str(source), options)
        missing = set(map(ord, characters)) - set(font.getBestCmap())
        if missing:
            raise ValueError(f'{source.name} is missing characters: {sorted(map(chr, missing))}')
        cutter = subset.Subsetter(options=options)
        cutter.populate(text=characters)
        cutter.subset(font)
        subset.save_font(font, str(target), options)
        with TTFont(target) as saved:
            assert not set(map(ord, characters)) - set(saved.getBestCmap())
        print(f'{target.name}: {target.stat().st_size:,} bytes')

if __name__ == '__main__':
    main()
