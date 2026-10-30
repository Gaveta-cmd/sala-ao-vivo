"""Servidor de sinalização e chat da Sala ao Vivo.

O vídeo, a voz e a tela trafegam direto entre os navegadores (WebRTC P2P).
Este servidor só apresenta os participantes de uma sala, repassa as mensagens
de negociação WebRTC (offer/answer/ICE) e distribui o chat de texto.
"""

import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
MAX_HISTORY = 100
MAX_NAME = 32
MAX_TEXT = 2000
MAX_PEERS = 8  # malha P2P: cada um envia para todos, então salas pequenas

app = FastAPI(title="Sala ao Vivo")


@dataclass
class Peer:
    id: str
    name: str
    ws: WebSocket
    muted: bool = True
    sharing: bool = False

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "muted": self.muted, "sharing": self.sharing}


@dataclass
class Room:
    peers: dict[str, Peer] = field(default_factory=dict)
    history: list[dict] = field(default_factory=list)


rooms: dict[str, Room] = {}


async def broadcast(room: Room, message: dict, exclude: str | None = None) -> None:
    for peer in list(room.peers.values()):
        if peer.id == exclude:
            continue
        try:
            await peer.ws.send_json(message)
        except Exception:
            pass  # a desconexão é tratada no loop do próprio participante


def clean_room_id(room_id: str) -> str:
    return "".join(c for c in room_id.lower() if c.isalnum() or c == "-")[:40]


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/nova-sala")
async def new_room() -> dict:
    return {"id": secrets.token_urlsafe(6).lower().replace("_", "-")}


@app.websocket("/ws/{room_id}")
async def room_socket(ws: WebSocket, room_id: str) -> None:
    room_id = clean_room_id(room_id)
    await ws.accept()
    if not room_id:
        await ws.close(code=4000, reason="sala inválida")
        return

    room = rooms.setdefault(room_id, Room())
    if len(room.peers) >= MAX_PEERS:
        await ws.send_json({"type": "error", "message": f"Sala cheia (máximo {MAX_PEERS})."})
        await ws.close(code=4001)
        return

    # A primeira mensagem do cliente precisa ser o "join" com o nome.
    try:
        hello = await ws.receive_json()
    except Exception:
        await ws.close(code=4002)
        return
    name = str(hello.get("name", "")).strip()[:MAX_NAME] or "Anônimo"

    peer = Peer(id=secrets.token_hex(4), name=name, ws=ws)
    await ws.send_json({
        "type": "welcome",
        "id": peer.id,
        "room": room_id,
        "peers": [p.public() for p in room.peers.values()],
        "history": room.history,
    })
    room.peers[peer.id] = peer
    await broadcast(room, {"type": "peer-joined", "peer": peer.public()}, exclude=peer.id)

    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")

            if kind == "signal":
                target = room.peers.get(msg.get("to", ""))
                if target:
                    await target.ws.send_json({"type": "signal", "from": peer.id, "data": msg.get("data")})

            elif kind == "chat":
                text = str(msg.get("text", "")).strip()[:MAX_TEXT]
                if not text:
                    continue
                entry = {"type": "chat", "from": peer.id, "name": peer.name, "text": text, "ts": int(time.time() * 1000)}
                room.history.append(entry)
                del room.history[:-MAX_HISTORY]
                await broadcast(room, entry)

            elif kind == "state":
                peer.muted = bool(msg.get("muted", peer.muted))
                peer.sharing = bool(msg.get("sharing", peer.sharing))
                await broadcast(room, {"type": "state", "peer": peer.public()}, exclude=peer.id)

    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        room.peers.pop(peer.id, None)
        await broadcast(room, {"type": "peer-left", "id": peer.id})
        if not room.peers:
            rooms.pop(room_id, None)


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
