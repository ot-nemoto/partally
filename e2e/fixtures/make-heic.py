"""E2E で使う HEIC の写真（sample.heic）を作る。

ffmpeg（libx265）で 1 枚の HEVC の画像を作り、HEIF の入れ物（ISO BMFF）に入れる。
見本の写真を外から持ち込まずに済むよう、自前で作る。作り直すときは e2e で
`python3 fixtures/make-heic.py` を実行する（ffmpeg と libx265 が要る）。
"""

import pathlib
import struct
import subprocess
import tempfile

WIDTH, HEIGHT = 320, 240
OUT = pathlib.Path(__file__).with_name("sample.heic")


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def full_box(kind: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return box(kind, struct.pack(">I", (version << 24) | flags) + payload)


def encode_hevc() -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / "image.hevc"
        subprocess.run(
            [
                "ffmpeg", "-loglevel", "error", "-f", "lavfi",
                "-i", f"testsrc=size={WIDTH}x{HEIGHT}:rate=1",
                "-frames:v", "1", "-pix_fmt", "yuv420p", "-c:v", "libx265",
                "-x265-params", "log-level=error:info=0", "-f", "hevc", str(out),
            ],
            check=True,
        )
        return out.read_bytes()


def split_nals(stream: bytes) -> list[bytes]:
    """Annex B の開始コード（00 00 01）で NAL に分ける"""
    nals, i = [], 0
    starts = []
    while (i := stream.find(b"\x00\x00\x01", i)) != -1:
        starts.append(i + 3)
        i += 3
    for n, s in enumerate(starts):
        end = starts[n + 1] - 3 if n + 1 < len(starts) else len(stream)
        nals.append(stream[s:end].rstrip(b"\x00"))
    return nals


def nal_type(nal: bytes) -> int:
    return (nal[0] >> 1) & 0x3F


def unescape(nal: bytes) -> bytes:
    return nal.replace(b"\x00\x00\x03", b"\x00\x00")


def hvcc(vps: bytes, sps: bytes, pps: bytes) -> bytes:
    # SPS の profile_tier_level（サブレイヤーが 1 つなら、NAL ヘッダ 2 バイトと 1 バイトの後の 12 バイト）
    ptl = unescape(sps)[3:15]
    out = bytes([1]) + ptl[0:1] + ptl[1:5] + ptl[5:11] + ptl[11:12]
    out += struct.pack(">H", 0xF000) + bytes([0xFC, 0xFD, 0xF8, 0xF8]) + struct.pack(">H", 0) + bytes([0x0F])
    arrays = [(32, vps), (33, sps), (34, pps)]
    out += bytes([len(arrays)])
    for kind, nal in arrays:
        out += bytes([0x80 | kind]) + struct.pack(">HH", 1, len(nal)) + nal
    return box(b"hvcC", out)


def main() -> None:
    nals = split_nals(encode_hevc())
    by_type = {nal_type(n): n for n in nals}
    vps, sps, pps = by_type[32], by_type[33], by_type[34]
    image = b"".join(struct.pack(">I", len(n)) + n for n in nals if nal_type(n) < 32)

    ftyp = box(b"ftyp", b"heic" + struct.pack(">I", 0) + b"mif1heic")

    def meta(offset: int) -> bytes:
        hdlr = full_box(b"hdlr", 0, 0, struct.pack(">I", 0) + b"pict" + b"\x00" * 12 + b"\x00")
        pitm = full_box(b"pitm", 0, 0, struct.pack(">H", 1))
        iloc = full_box(b"iloc", 0, 0, bytes([0x44, 0x00]) + struct.pack(">HHHHII", 1, 1, 0, 1, offset, len(image)))
        infe = full_box(b"infe", 2, 0, struct.pack(">HH", 1, 0) + b"hvc1" + b"\x00")
        iinf = full_box(b"iinf", 0, 0, struct.pack(">H", 1) + infe)
        ispe = full_box(b"ispe", 0, 0, struct.pack(">II", WIDTH, HEIGHT))
        ipco = box(b"ipco", hvcc(vps, sps, pps) + ispe)
        ipma = full_box(b"ipma", 0, 0, struct.pack(">IHB", 1, 1, 2) + bytes([0x81, 0x02]))
        return full_box(b"meta", 0, 0, hdlr + pitm + iloc + iinf + box(b"iprp", ipco + ipma))

    # mdat の中身の位置は meta の大きさで決まる（meta の大きさは位置の値によらない）
    offset = len(ftyp) + len(meta(0)) + 8
    OUT.write_bytes(ftyp + meta(offset) + box(b"mdat", image))
    print(f"{OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
