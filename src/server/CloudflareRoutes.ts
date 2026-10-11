// ============================================================
// Cloudflare Routes - API endpoints for room management
// ============================================================

// Generate a random 6-char room code
function generateRoomCode(): string {
  const chars: string = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code: string = "";
  for (let i: number = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// GET /api/rooms - List rooms or get room info
export async function GET(request: Request): Promise<Response> {
  const url: URL = new URL(request.url);
  const code: string | null = url.pathname.replace("/api/rooms/", "");
  
  // In production, connect to Durable Object
  // For now, return room info
  return new Response(
    JSON.stringify({
      code,
      status: "waiting",
      players: 0,
      maxPlayers: 4,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

// POST /api/rooms - Create or join room
export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  const { code, playerName, playerID } = body;
  
  if (code) {
    // Join existing room
    return new Response(
      JSON.stringify({
        success: true,
        matchID: code,
        playerID: playerID || `player_${Math.random().toString(36).slice(2)}`,
        turn: 0,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } else {
    // Create new room
    const newCode: string = generateRoomCode();
    return new Response(
      JSON.stringify({
        success: true,
        matchID: newCode,
        playerID: `player_${Math.random().toString(36).slice(2)}`,
        turn: 0,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// WS /api/rooms/:code/connect - WebSocket connection
export async function WS(request: Request): Promise<Response> {
  const url: URL = new URL(request.url);
  const code: string | null = url.pathname.replace("/api/rooms/", "");
  
  // Upgrade to WebSocket
  const ws: WebSocket = new WebSocket(request.url);
  
  ws.onopen = () => {
    console.log(`WebSocket connected for room code: ${code}`);
  };
  
  ws.onmessage = (event: MessageEvent) => {
    try {
      const data: any = JSON.parse(event.data as string);
      // Handle message types:
      // - join_match: { type: "join_match", payload: { playerID, sessionToken } }
      // - execute_command: { type: "execute_command", payload: { commandID, playerID, payload, version } }
      // - get_snapshot: { type: "get_snapshot" }
      // - player_event: { type: "player_event", payload: { type, playerID } }
      console.log("WebSocket message received:", data.type);
    } catch (e) {
      console.error("Failed to parse WebSocket message:", e);
    }
  };
  
  ws.onclose = () => {
    console.log("WebSocket closed");
  };
  
  ws.onerror = (error: Error) => {
    console.error("WebSocket error:", error);
  };
  
  // Return 101 Switching Protocols response
  return new Response(null, {
    status: 101,
    headers: {
      "Upgrade": "websocket",
      "Connection": "upgrade",
    },
  });
}