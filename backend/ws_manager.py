import json
from collections import defaultdict
from fastapi import WebSocket


class ConnectionManager:
    """Manages WebSocket connections grouped by (org_id, event_id)."""

    def __init__(self):
        # key: (org_id, event_id) → list of websockets
        self.rooms: dict[tuple, list[WebSocket]] = defaultdict(list)

    async def connect(self, websocket: WebSocket, org_id: int, event_id: str):
        await websocket.accept()
        self.rooms[(org_id, event_id)].append(websocket)

    def disconnect(self, websocket: WebSocket, org_id: int, event_id: str):
        room = self.rooms.get((org_id, event_id), [])
        if websocket in room:
            room.remove(websocket)

    async def broadcast(self, org_id: int, event_id: str, message: dict, exclude: WebSocket = None):
        """Send a message to all connections in a room, optionally excluding the sender."""
        dead = []
        for ws in self.rooms.get((org_id, event_id), []):
            if ws is exclude:
                continue
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, org_id, event_id)

    def room_size(self, org_id: int, event_id: str) -> int:
        return len(self.rooms.get((org_id, event_id), []))


manager = ConnectionManager()
