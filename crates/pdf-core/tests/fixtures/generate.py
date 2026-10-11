"""Generate tiny self-authored PDF permission fixtures using Python's standard library.

The legacy RC4 security handler is used only as an interoperability test fixture.
These PDFs contain no sensitive data and are not examples of secure encryption.
"""

from hashlib import md5
from pathlib import Path
from struct import pack

PADDING = bytes.fromhex("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a")


def rc4(key, data):
    state = list(range(256))
    j = 0
    for i in range(256):
        j = (j + state[i] + key[i % len(key)]) % 256
        state[i], state[j] = state[j], state[i]
    i = j = 0
    result = bytearray()
    for byte in data:
        i = (i + 1) % 256
        j = (j + state[i]) % 256
        state[i], state[j] = state[j], state[i]
        result.append(byte ^ state[(state[i] + state[j]) % 256])
    return bytes(result)


def generate(password, name):
    padded = (password.encode() + PADDING)[:32]
    owner = rc4(md5((b"fixture-owner" + PADDING)[:32]).digest()[:5], padded)
    identifier = md5(name.encode()).digest()
    key = md5(padded + owner + pack("<i", -64) + identifier).digest()[:5]
    user = rc4(key, PADDING)
    stream = b"BT /F1 16 Tf 20 220 Td (Permission test) Tj ET\n"
    stream = rc4(md5(key + b"\x04\x00\x00\x00\x00").digest()[:10], stream)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length "
        + str(len(stream)).encode()
        + b" >>\nstream\n"
        + stream
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Filter /Standard /V 1 /R 2 /Length 40 /O <{owner.hex()}> /U <{user.hex()}> /P -64 >>".encode(),
    ]
    result = bytearray(b"%PDF-1.7\n")
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(result)
    result.extend(b"xref\n0 7\n0000000000 65535 f \n")
    for offset in offsets:
        result.extend(f"{offset:010} 00000 n \n".encode())
    result.extend(
        f"trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID "
        f"[<{identifier.hex()}> <{identifier.hex()}>] >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    Path(__file__).with_name(name).write_bytes(result)


if __name__ == "__main__":
    generate("", "restricted.pdf")
    generate("fixture-password", "password.pdf")
