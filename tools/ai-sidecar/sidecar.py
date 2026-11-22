#!/usr/bin/env python3
"""Nexus Voice AI sidecar — protocol v1 reference implementation.

This server speaks the framed JSON + PCM protocol described in
``docs/AI_SIDECAR.md``. It intentionally ships with a *passthrough* backend:
the framing, handshake, chunking, ping/pong and error paths are real, while the
RVC/ONNX inference hook is left for the next milestone.

Run:

    python tools/ai-sidecar/sidecar.py --backend passthrough

Only the Python standard library is required.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import struct
import sys
from typing import Sequence

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1024 * 1024

KIND_JSON = 0x4A
KIND_AUDIO = 0x41
KIND_PING = 0x50
KIND_PONG = 0x51

SUPPORTED_RATES = {44_100, 48_000, 88_200, 96_000, 192_000}
CHUNK_MIN = 160
CHUNK_MAX = 15_360


class ProtocolError(Exception):
    """A recoverable protocol violation."""


# ---------------------------------------------------------------------------
# Converters
# ---------------------------------------------------------------------------


class Converter:
    """Audio transformation hook.

    ``process`` receives mono float samples and must return the same number of
    samples. Keeping the contract length-preserving makes the transport simple:
    one request frame in, one response frame out.
    """

    backend = "base"
    model: str | None = None
    rtf = 1.0

    def process(self, samples: Sequence[float]) -> Sequence[float]:
        raise NotImplementedError


class PassthroughConverter(Converter):
    """Returns the dry signal unchanged. Useful for transport tests."""

    backend = "passthrough"

    def process(self, samples: Sequence[float]) -> Sequence[float]:
        return samples


class OnnxConverter(Converter):
    """Placeholder for the RVC backend.

    A real implementation must:

    1. load ``.onnx`` with ``onnxruntime.InferenceSession`` (CUDA or CPU),
    2. load the optional ``.index`` and apply retrieval mixing,
    3. convert the chunk with the model's expected sample rate,
    4. return exactly ``len(samples)`` values.

    It is deliberately not faked here: starting the sidecar with ``--backend
    onnx`` fails with a clear message until that work lands.
    """

    backend = "onnx"

    def __init__(self, model: str | None) -> None:
        raise RuntimeError(
            "ONNX/RVC backend is not implemented yet; run with --backend passthrough"
        )


def make_converter(backend: str, model: str | None) -> Converter:
    if backend == "passthrough":
        return PassthroughConverter()
    if backend == "onnx":
        return OnnxConverter(model)
    raise ValueError(f"unknown backend: {backend}")


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    """Read one ``[u32 len][u8 kind][payload]`` frame."""
    header = await reader.readexactly(4)
    (length,) = struct.unpack("<I", header)
    if length < 1 or length > MAX_FRAME_BYTES:
        raise ProtocolError(f"invalid frame length: {length}")
    body = await reader.readexactly(length)
    return body[0], body[1:]


async def write_frame(
    writer: asyncio.StreamWriter, kind: int, payload: bytes
) -> None:
    writer.write(struct.pack("<I", len(payload) + 1) + bytes([kind]) + payload)
    await writer.drain()


async def write_json(writer: asyncio.StreamWriter, message: dict) -> None:
    await write_frame(
        writer, KIND_JSON, json.dumps(message, separators=(",", ":")).encode("utf-8")
    )


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------


class Session:
    def __init__(self, converter: Converter, verbose: bool) -> None:
        self.converter = converter
        self.verbose = verbose

    def log(self, message: str) -> None:
        if self.verbose:
            print(f"[nexus-ai] {message}", flush=True)

    async def run(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        peer = writer.get_extra_info("peername")
        self.log(f"client connected: {peer}")
        try:
            await self.handshake(reader, writer)
            await self.stream(reader, writer)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            self.log("client disconnected")
        except ProtocolError as error:
            self.log(f"protocol error: {error}")
            try:
                await write_json(
                    writer, {"type": "error", "code": "bad_frame", "message": str(error)}
                )
            except (ConnectionError, asyncio.IncompleteReadError):
                pass
        except Exception as error:  # noqa: BLE001 - never crash the server loop
            self.log(f"session error: {error!r}")
            try:
                await write_json(
                    writer, {"type": "error", "code": "internal", "message": str(error)}
                )
            except (ConnectionError, asyncio.IncompleteReadError):
                pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, asyncio.IncompleteReadError):
                pass

    async def handshake(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        kind, payload = await asyncio.wait_for(read_frame(reader), timeout=3.0)
        if kind != KIND_JSON:
            raise ProtocolError("expected JSON hello")
        hello = json.loads(payload)
        if hello.get("type") != "hello":
            raise ProtocolError("expected hello message")

        protocol = hello.get("protocol")
        if protocol != PROTOCOL_VERSION:
            await write_json(
                writer,
                {
                    "type": "error",
                    "code": "unsupported_protocol",
                    "message": f"protocol {protocol} is not supported",
                },
            )
            raise ProtocolError(f"unsupported protocol: {protocol}")

        sample_rate = int(hello.get("sample_rate", 48_000))
        chunk_frames = int(hello.get("chunk_frames", 1_920))
        channels = int(hello.get("channels", 1))

        if sample_rate not in SUPPORTED_RATES:
            await write_json(
                writer,
                {
                    "type": "error",
                    "code": "unsupported_rate",
                    "message": f"sample rate {sample_rate} is not supported",
                },
            )
            raise ProtocolError(f"unsupported sample rate: {sample_rate}")
        if not CHUNK_MIN <= chunk_frames <= CHUNK_MAX:
            await write_json(
                writer,
                {
                    "type": "error",
                    "code": "bad_chunk",
                    "message": f"chunk_frames must be {CHUNK_MIN}..{CHUNK_MAX}",
                },
            )
            raise ProtocolError(f"bad chunk size: {chunk_frames}")
        if channels != 1:
            await write_json(
                writer,
                {
                    "type": "error",
                    "code": "unsupported_channels",
                    "message": "sidecar expects mono f32 audio",
                },
            )
            raise ProtocolError(f"unsupported channels: {channels}")

        await write_json(
            writer,
            {
                "type": "ready",
                "protocol": PROTOCOL_VERSION,
                "backend": self.converter.backend,
                "model": self.converter.model,
                "sample_rate": sample_rate,
                "chunk_frames": chunk_frames,
                "rtf": self.converter.rtf,
            },
        )
        self.log(
            f"ready: backend={self.converter.backend} rate={sample_rate} chunk={chunk_frames}"
        )

    async def stream(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        while True:
            kind, payload = await read_frame(reader)

            if kind == KIND_AUDIO:
                await self.handle_audio(writer, payload)
            elif kind == KIND_PING:
                await write_frame(writer, KIND_PONG, b"")
            elif kind == KIND_JSON:
                await self.handle_json(writer, payload)
            else:
                raise ProtocolError(f"unknown frame kind: 0x{kind:02X}")

    async def handle_audio(
        self, writer: asyncio.StreamWriter, payload: bytes
    ) -> None:
        if len(payload) < 4 or (len(payload) - 4) % 4 != 0:
            raise ProtocolError("audio payload must be u32 seq + f32 samples")
        (seq,) = struct.unpack_from("<I", payload, 0)
        count = (len(payload) - 4) // 4
        samples = struct.unpack_from(f"<{count}f", payload, 4) if count else ()

        processed = self.converter.process(samples)
        if len(processed) != count:
            raise ProtocolError(
                f"converter returned {len(processed)} samples, expected {count}"
            )

        clean = [0.0 if not math.isfinite(value) else value for value in processed]
        body = struct.pack("<I", seq)
        if clean:
            body += struct.pack(f"<{count}f", *clean)
        await write_frame(writer, KIND_AUDIO, body)

    async def handle_json(
        self, writer: asyncio.StreamWriter, payload: bytes
    ) -> None:
        try:
            message = json.loads(payload)
        except json.JSONDecodeError as error:
            raise ProtocolError(f"invalid JSON: {error}") from error

        message_type = message.get("type")
        if message_type == "ping":
            await write_json(writer, {"type": "pong"})
        elif message_type == "configure":
            # Model/parameter changes are accepted in v1 but only stored for
            # logging; the passthrough converter ignores them.
            self.log(f"configure: {message}")
            await write_json(writer, {"type": "configured", "ok": True})
        elif message_type == "shutdown":
            await write_json(writer, {"type": "bye"})
            raise asyncio.IncompleteReadError(b"", 0)
        else:
            raise ProtocolError(f"unknown JSON message: {message_type}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def serve(args: argparse.Namespace) -> None:
    converter = make_converter(args.backend, args.model)
    session = Session(converter, verbose=args.verbose)

    server = await asyncio.start_server(
        session.run, host=args.host, port=args.port, limit=MAX_FRAME_BYTES
    )
    addresses = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
    print(
        f"[nexus-ai] listening on {addresses} · backend={converter.backend}",
        flush=True,
    )
    async with server:
        await server.serve_forever()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Nexus-Mixer Voice AI sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47_600)
    parser.add_argument(
        "--backend",
        choices=("passthrough", "onnx"),
        default="passthrough",
        help="passthrough keeps the dry signal; onnx is reserved for RVC",
    )
    parser.add_argument("--model", default=None, help="path to an .onnx model")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("[nexus-ai] stopped", flush=True)
        return 0
    except (RuntimeError, ValueError) as error:
        print(f"[nexus-ai] {error}", file=sys.stderr, flush=True)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
