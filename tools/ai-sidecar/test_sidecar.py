#!/usr/bin/env python3
"""Self-test for the sidecar transport (no audio device required).

    python tools/ai-sidecar/test_sidecar.py
"""

from __future__ import annotations

import asyncio
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))

import sidecar  # noqa: E402


async def main() -> int:
    converter = sidecar.PassthroughConverter()
    session = sidecar.Session(converter, verbose=False)
    server = await asyncio.start_server(session.run, host="127.0.0.1", port=0)
    port = server.sockets[0].getsockname()[1]

    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        hello = {
            "type": "hello",
            "protocol": sidecar.PROTOCOL_VERSION,
            "client": "self-test",
            "sample_rate": 48_000,
            "chunk_frames": 1_920,
            "channels": 1,
        }
        await sidecar.write_json(writer, hello)
        kind, payload = await sidecar.read_frame(reader)
        assert kind == sidecar.KIND_JSON
        ready = json.loads(payload)
        assert ready["type"] == "ready", ready
        assert ready["backend"] == "passthrough", ready

        samples = (0.1, -0.2, 0.3, 0.0)
        body = struct.pack("<I", 7) + struct.pack(f"<{len(samples)}f", *samples)
        await sidecar.write_frame(writer, sidecar.KIND_AUDIO, body)
        kind, payload = await sidecar.read_frame(reader)
        assert kind == sidecar.KIND_AUDIO
        (seq,) = struct.unpack_from("<I", payload, 0)
        echoed = struct.unpack_from(f"<{len(samples)}f", payload, 4)
        assert seq == 7, seq
        assert len(echoed) == len(samples)
        assert all(abs(a - b) < 1e-6 for a, b in zip(echoed, samples)), (echoed, samples)

        await sidecar.write_frame(writer, sidecar.KIND_PING, b"")
        kind, _ = await sidecar.read_frame(reader)
        assert kind == sidecar.KIND_PONG

        print("sidecar self-test: OK")
        return 0
    finally:
        writer.close()
        await writer.wait_closed()
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
