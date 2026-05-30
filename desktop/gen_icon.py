"""Generates the app icon (RGBA PNG) using only the stdlib -- an orange disc
with a dark ring ('capsule/target' style), on a transparent background."""
import zlib, struct, math, os

ORANGE = (255, 122, 24)
DARK = (16, 18, 22)


def make(size):
    cx = cy = (size - 1) / 2
    r_out = size * 0.46
    r_ring = size * 0.30
    r_in = size * 0.14
    px = bytearray()
    for y in range(size):
        px.append(0)  # row filter = none
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            if d <= r_in:
                col, a = ORANGE, 255
            elif d <= r_ring:
                col, a = DARK, 255
            elif d <= r_out:
                col, a = ORANGE, 255
            else:
                col, a = (0, 0, 0), 0
            px += bytes((col[0], col[1], col[2], a))
    return px


def png(size, path):
    raw = make(size)
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(out)
    print("scritto", path, size, "px")


for s in (32, 64, 256):
    png(s, f"assets/icon-{s}.png")
# alias used by the tray
import shutil; shutil.copy("assets/icon-64.png", "assets/tray.png")
print("ok")
