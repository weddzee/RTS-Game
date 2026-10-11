// src/core/CloudflareDurableObjects.ts
// Cloudflare Durable Object scaffold for prompt 11.1 - same GameCore used by
// both local and Cloudflare.
//
// This does not yet claim to implement HostingAdapter (see
// src/core/game/Game.ts): that conformance lands together with the Worker
// wiring. What lives here today is the room + WebSocket scaffolding.

import type {
  CommandResult,
  GameSnapshot,
  PlayerSession,
  TickStatus,
} from "./game/Game";
import type { TileRef } from "./game/GameMap";

// ============================================================
// Cloudflare Durable Object Adapter
// ============================================================

export class CloudflareDurableObject {
  private state: Map<string, any> = new Map();
  private players: Map<string, PlayerSession> = new Map();
  private matchID: string | null = null;
  private wsClients: Map<string, WebSocket> = new Map();

  // Cloudflare context references (set by Worker runtime)
  private script: any;
  private env: any;
  private ctx: any;

  // ============================================================
  // Constructor - Cloudflare sets these via class constructor
  // ============================================================
  constructor(script: any, env: any, ctx: any) {
    this.script = script;
    this.env = env;
    this.ctx = ctx;
    // Initialize from env if needed (e.g., Durable Object namespace)
  }

  // ============================================================
  // fetch - Entry point for all HTTP/WebSocket requests
  // ============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ============ WebSocket Game Connections ============
    if (url.pathname.startsWith("/ws/")) {
      const code = url.pathname.substring(5);
      return this.handleWebSocketConnection(request, code);
    }

    // ============ API Routes ============

    // ============ Room Creation (Prompt 11.8) ============
    if (url.pathname === "/api/rooms") {
      if (request.method === "POST") return this.handleCreateRoom(request);
      if (request.method === "GET") return this.handleListRooms(request);
    }

    // ============ Room Specific Operations ============
    if (url.pathname.startsWith("/api/rooms/")) {
      const code = url.pathname.split("/")[3];
      if (request.method === "GET") return this.handleGetRoom(code);
      if (request.method === "WS") return this.handleWebSocketConnection(request, code);
      if (request.method === "DELETE") return this.handleDeleteRoom(code);
    }

    return new Response("Not found", { status: 404 });
  }

  // ============================================================
  // WebSocket Game Connection Handler
  // ============================================================

  private async handleWebSocketConnection(request: Request, code: string): Promise<Response> {
    const ws = new WebSocket(request.url);
    this.wsClients.set(code, ws);

    ws.onopen = () => {
      // Notify match state manager
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);
        this.handleMessage(code, data);
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };

    ws.onclose = () => {
      this.wsClients.delete(code);
      // Optionally handle player disconnect
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

  private handleMessage(code: string, data: any): void {
    const { type, payload } = data;

    switch (type) {
      case "join_match":
        this.handleJoinMatch(code, payload);
        break;
      case "execute_command":
        this.handleExecuteCommand(code, payload);
        break;
      case "get_snapshot":
        this.handleGetSnapshot(code);
        break;
      case "player_event":
        this.handlePlayerEvent(code, payload);
        break;
      default:
        console.log(`Unknown message type: ${type}`);
    }
  }

  // ============================================================
  // Match Management
  // ============================================================

  private matchStarted: boolean = false;

  private async handleJoinMatch(code: string, payload: any): Promise<void> {
    const playerID: string = payload.playerID;
    const sessionToken: string = payload.sessionToken;

    // Create match if not exists
    if (!this.matchID) {
      this.matchID = code;
      this.state.set(code, {
        turn: 0,
        players: new Map<string, PlayerSession>(),
        armies: new Map<string, any>(),
        airWings: new Map<string, any>(),
        factories: new Map<string, any>(),
        supply: new Map<string, number>(),
      });
    }

    const match = this.state.get(code);
    if (!match) return;
    const playerSession: PlayerSession = {
      playerID,
      sessionToken,
      isAlive: true,
      lastReceivedTick: 0,
    };

    match.players.set(playerID, playerSession);
    this.players.set(playerID, playerSession);

    // Respond with success
    this.broadcastTo(code, {
      type: "join_success",
      playerID,
      matchID: this.matchID,
      turn: match.turn,
    });
  }

  private async handleExecuteCommand(code: string, payload: any): Promise<void> {
    const { commandID, playerID, payload: cmdPayload, version } = payload;

    if (!this.matchID) return;
    const match = this.state.get(this.matchID);
    if (!match) return;
    const playerSession = match.players.get(playerID);

    if (!playerSession || !playerSession.isAlive) {
      this.broadcastTo(code, {
        type: "command_error",
        error: "Player not in match or not alive",
      });
      return;
    }

    // Validate protocol version
    if (version !== 1) {
      this.broadcastTo(code, {
        type: "command_error",
        error: "Unsupported protocol version",
      });
      return;
    }

    // Process command based on type
    const { type } = cmdPayload;
    let result: CommandResult;

    switch (type) {
      case "create_army":
        result = this.handleCreateArmy(code, cmdPayload, playerSession);
        break;
      case "build_factory":
        result = this.handleBuildFactory(code, cmdPayload, playerSession);
        break;
      case "create_air_wing":
        result = this.handleCreateAirWing(code, cmdPayload, playerSession);
        break;
      case "assign_air_mission":
        result = this.handleAssignAirMission(code, cmdPayload, playerSession);
        break;
      case "airlift_army":
        result = this.handleAirliftArmy(code, cmdPayload, playerSession);
        break;
      default:
        result = {
          success: false,
          failureReason: "Unknown command type",
        };
    }

    this.broadcastTo(code, {
      type: "command_result",
      result,
      commandID,
    });
  }

  // ============================================================
  // Command Handlers
  // ============================================================

  private handleCreateArmy(code: string, payload: any, player: PlayerSession): CommandResult {
    const match = this.state.get(code);
    if (!match) return { success: false, failureReason: "Match not found", tick: 0 };
    const { troops, name, composition } = payload;

    const armyID: string = `army_${Date.now()}`;
    match.armies.set(armyID, {
      id: armyID,
      ownerID: player.playerID,
      strength: troops,
      composition: composition || { infantry: troops, armor: 0, artillery: 0, support: 0 },
      isActive: true,
      tile: null,
      order: { type: "stop" },
    });

    return {
      success: true,
      tick: match.turn,
      delta: { armies: match.armies },
    };
  }

  private handleBuildFactory(code: string, payload: any, player: PlayerSession): CommandResult {
    const match = this.state.get(code);
    if (!match) return { success: false, failureReason: "Match not found", tick: 0 };
    const { tile }: { tile: TileRef } = payload;

    match.factories.set(tile, {
      id: `factory_${tile}`,
      ownerID: player.playerID,
      isActive: true,
      tile,
      producing: false,
      productionTurns: 0,
    });

    return {
      success: true,
      tick: match.turn,
      delta: { factories: match.factories },
    };
  }

  private handleCreateAirWing(code: string, payload: any, player: PlayerSession): CommandResult {
    const match = this.state.get(code);
    if (!match) return { success: false, failureReason: "Match not found", tick: 0 };
    const { aircraftType, requestedName, regionID }: {
      aircraftType: string;
      requestedName: string | null;
      regionID: number | null;
    } = payload;

    const wingID: string = `wing_${Date.now()}`;
    match.airWings.set(wingID, {
      id: wingID,
      ownerID: player.playerID,
      aircraftType: aircraftType as any,
      aircraftCount: 8, // WING_START_AIRCRAFT
      losses: 0,
      experience: 0,
      regionID: regionID ?? null,
      mission: { type: "airSuperiority" },
      isActive: true,
    });

    return {
      success: true,
      tick: match.turn,
      delta: { airWings: match.airWings },
    };
  }

  private handleAssignAirMission(code: string, payload: any, player: PlayerSession): CommandResult {
    const match = this.state.get(code);
    if (!match) return { success: false, failureReason: "Match not found", tick: 0 };
    const { wingID, missionType, target }: {
      wingID: string;
      missionType: string;
      target?: string;
    } = payload;

    const wing = match.airWings.get(wingID);
    if (!wing) {
      return { success: false, failureReason: "Wing not found" };
    }

    const validMissions: string[] = ["airSuperiority", "intercept", "strike"];
    if (!validMissions.includes(missionType)) {
      return { success: false, failureReason: "Invalid mission type" };
    }

    wing.mission = { type: missionType };
    if (target) wing.mission.target = target;

    return {
      success: true,
      tick: match.turn,
      delta: { airWings: match.airWings },
    };
  }

  private handleAirliftArmy(code: string, payload: any, player: PlayerSession): CommandResult {
    const match = this.state.get(code);
    if (!match) return { success: false, failureReason: "Match not found", tick: 0 };
    const { wingID, destinationRef }: { wingID: string; destinationRef: TileRef } = payload;

    const wing = match.airWings.get(wingID);
    if (!wing) {
      return { success: false, failureReason: "Wing not found" };
    }

    // Simple airlift - give experience
    wing.experience = (wing.experience ?? 0) + 5; // HELICOPTER_XP_PER_LIFT

    return {
      success: true,
      tick: match.turn,
      delta: { airWings: match.airWings },
    };
  }

  // ============================================================
  // Match Advancement
  // ============================================================

  async advanceTick(matchID: string): Promise<TickStatus> {
    const match = this.state.get(matchID);
    if (!match) throw new Error("Match not found");

    match.turn++;

    // TODO: Full game tick logic:
    // - Factory production
    // - Army movement/resolution  
    // - Combat resolution
    // - Experience gain
    // - Supply status updates
    // - Victory condition checks

    return {
      currentTick: match.turn,
      advanced: true,
      reason: "Turn advanced (full tick logic pending)",
    };
  }

  async getSnapshot(matchID: string): Promise<GameSnapshot> {
    const match = this.state.get(matchID);
    if (!match) throw new Error("Match not found");

    return {
      sequence: match.turn,
      state: this.serializeState(match),
      tick: match.turn,
      visibleState: this.buildVisibleState(match),
    };
  }

  private buildVisibleState(match: any): any {
    return {
      players: this.buildVisiblePlayers(match),
      armies: this.buildVisibleArmies(match),
      airWings: this.buildVisibleAirWings(match),
      factories: this.buildVisibleFactories(match),
    };
  }

  private serializeState(match: any): any {
    return {
      turn: match.turn,
      players: Array.from(match.players.entries()),
      armies: Array.from(match.armies.entries()),
      airWings: Array.from(match.airWings.entries()),
      factories: Array.from(match.factories.entries()),
    };
  }

  private broadcastTo(code: string, data: any): void {
    const ws = this.wsClients.get(code);
    if (ws) {
      try {
        ws.send(JSON.stringify(data));
      } catch (e) {
        console.error("Failed to broadcast to client:", e);
        this.wsClients.delete(code);
      }
    }
  }

  private broadcastAll(data: any): void {
    for (const [code, ws] of this.wsClients) {
      this.broadcastTo(code, data);
    }
  }

  private handleLeaveMatch(code: string, playerID: string): void {
    const match = this.state.get(code);
    if (!match) return;

    match.players.delete(playerID);
    this.players.delete(playerID);

    if (match.players.size === 0 && this.matchID) {
      this.state.delete(this.matchID);
      this.matchID = null;
    }
  }

  private handlePlayerEvent(code: string, payload: any): void {
    const { type, playerID } = payload;

    switch (type) {
      case "leave":
        this.handleLeaveMatch(code, playerID);
        break;
      case "reconnect":
        // Restore player state for reconnection
        // ... (implement based on your needs)
        break;
      default:
        console.log(`Unknown player event: ${type}`);
    }
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  private generateRoomCode(): string {
    const chars: string = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code: string = "";
    for (let i: number = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // ============================================================
  // Command Type Handlers
  // ============================================================

  // Already covered in handleExecuteCommand above

  // ============================================================
  // State Management Helpers
  // ============================================================

  private buildVisiblePlayers(match: any): any {
    const visible: any = {};
    for (const [pid, p] of match.players) {
      visible[pid] = {
        id: p.playerID,
        isAlive: p.isAlive,
        lastReceivedTick: p.lastReceivedTick,
      };
    }
    return visible;
  }

  private buildVisibleArmies(match: any): any {
    const visible: any = {};
    for (const [aid, a] of match.armies.entries()) {
      visible[aid] = {
        id: a.id,
        ownerID: a.ownerID,
        strength: a.strength,
        isActive: a.isActive,
      };
    }
    return visible;
  }

  private buildVisibleAirWings(match: any): any {
    const visible: any = {};
    for (const [wid, w] of match.airWings.entries()) {
      visible[wid] = {
        id: w.id,
        ownerID: w.ownerID,
        aircraftType: w.aircraftType,
        aircraftCount: w.aircraftCount,
        isActive: w.isActive,
        mission: w.mission,
      };
    }
    return visible;
  }

  private buildVisibleFactories(match: any): any {
    const visible: any = {};
    for (const [fid, f] of match.factories.entries()) {
      visible[fid] = {
        id: f.id,
        ownerID: f.ownerID,
        isActive: f.isActive,
        tile: f.tile,
      };
    }
    return visible;
  }
}