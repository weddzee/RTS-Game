// Minimal private-lobby menu for the friends-and-classmates build (Prompt 1).
//
// "Open browser -> enter nickname -> create/join private room -> choose
// spawn -> play." No account, no store, no matchmaking.
//
// The nickname is validated with validatePrivateNickname (1-20 visible
// chars, trimmed, HTML-safe charset) and persisted to browser localStorage
// only, under the same "username" key the upstream <username-input> reads,
// so a refresh keeps the name everywhere. Main.handleJoinLobby prefers
// currentNickname() over the account input; the game server remains
// authoritative (trim + clamp + room disambiguation in Worker.ts).
//
// All interpolated values render through Lit ${} bindings, which escape
// HTML by construction. Nicknames never touch innerHTML here.

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GameMapType } from "../core/game/Game";
import { maps } from "../core/game/Maps.gen";
import {
  MATCH_PACING_PRESETS,
  type MatchPacingPreset,
} from "../core/MatchPacing";
import { validatePrivateNickname } from "../core/PrivateNickname";
import { isValidRoomCode, normalizeRoomCode } from "../server/PrivateRooms";
import { createPrivateRoom, resolveRoomCode } from "./Api";
import "./components/baseComponents/Button";
import type { CreditsModal } from "./CreditsModal";
import type { HostLobbyModal } from "./HostLobbyModal";
import type { JoinLobbyModal } from "./JoinLobbyModal";
import { translateText } from "./Utils";

export const PRIVATE_MENU_NICKNAME_KEY = "username";

function readStoredNickname(): string {
  try {
    return localStorage.getItem(PRIVATE_MENU_NICKNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

@customElement("private-lobby-menu")
export class PrivateLobbyMenu extends LitElement {
  @state() private nickname = readStoredNickname();
  @state() private roomCodeInput = "";
  @state() private pacing: MatchPacingPreset = "standard";
  @state() private map: GameMapType = GameMapType.World;
  @state() private bots = 0;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private createdCode: string | null = null;

  createRenderRoot() {
    return this;
  }

  /** Validated nickname, or null. Read by Main.handleJoinLobby. */
  public currentNickname(): string | null {
    const result = validatePrivateNickname(this.nickname);
    return result.isValid ? (result.value ?? null) : null;
  }

  private setNickname(value: string) {
    this.nickname = value;
    this.error = null;
    try {
      // Persist raw; validation happens on read. Upstream username-input
      // reads the same key on its next load.
      localStorage.setItem(PRIVATE_MENU_NICKNAME_KEY, value);
    } catch {
      // Private-mode browsing: play on without persisting.
    }
  }

  private requireNickname(): string | null {
    const result = validatePrivateNickname(this.nickname);
    if (!result.isValid || !result.value) {
      const key =
        result.error === "too_long"
          ? "private_menu.nickname_error_too_long"
          : result.error === "invalid_chars" || result.error === "no_alnum"
            ? "private_menu.nickname_error_invalid"
            : "private_menu.nickname_error_required";
      this.error = translateText(key);
      return null;
    }
    return result.value;
  }

  private async handleCreate() {
    const name = this.requireNickname();
    if (name === null || this.busy) return;
    this.busy = true;
    this.error = null;
    this.createdCode = null;
    try {
      const created = await createPrivateRoom(
        { gameMap: this.map, bots: this.bots },
        { durationPreset: this.pacing, bots: this.bots },
      );
      this.createdCode = created.roomCode;
      try {
        await navigator.clipboard.writeText(created.roomCode);
      } catch {
        // Clipboard unavailable (permissions/iframe): the code stays visible.
      }
      // Attach the existing host-lobby UI to the minted game; it dispatches
      // join-lobby (source "host") itself once bound.
      (
        document.querySelector("host-lobby-modal") as HostLobbyModal | null
      )?.open({ existingLobbyId: created.gameID });
    } catch (err) {
      console.error("Private room creation failed:", err);
      this.error = translateText("private_menu.create_failed");
    } finally {
      this.busy = false;
    }
  }

  private async handleJoin() {
    const name = this.requireNickname();
    if (name === null || this.busy) return;
    const code = normalizeRoomCode(this.roomCodeInput);
    if (!isValidRoomCode(code)) {
      this.error = translateText("private_menu.room_not_found");
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const resolved = await resolveRoomCode(code);
      if (resolved === null) {
        this.error = translateText("private_menu.room_not_found");
        return;
      }
      if (resolved.hasStarted) {
        this.error = translateText("private_menu.room_started");
        return;
      }
      // Route through the standard private join modal so lobby info,
      // spectate, and version checks behave exactly as before.
      (
        document.querySelector("join-lobby-modal") as JoinLobbyModal | null
      )?.open({ lobbyId: resolved.gameID });
    } catch (err) {
      console.error("Private room join failed:", err);
      this.error = translateText("private_menu.join_failed");
    } finally {
      this.busy = false;
    }
  }

  private openSettings() {
    window.showPage?.("page-settings");
  }

  private openCredits() {
    (document.querySelector("credits-modal") as CreditsModal | null)?.open();
  }

  render() {
    return html`
      <section
        class="w-full max-w-2xl mx-auto flex flex-col gap-4 p-6 bg-surface border border-white/10 rounded-2xl"
        aria-label=${translateText("private_menu.title")}
      >
        <h1
          class="text-3xl font-bold tracking-wide text-center text-white"
          data-i18n="private_menu.product_name"
        >
          ${translateText("private_menu.product_name")}
        </h1>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-white/70">
            ${translateText("private_menu.nickname_label")}
          </span>
          <input
            type="text"
            maxlength="20"
            autocomplete="nickname"
            .value=${this.nickname}
            placeholder=${translateText("private_menu.nickname_placeholder")}
            @input=${(e: Event) =>
              this.setNickname((e.target as HTMLInputElement).value)}
            class="px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <o-button
          title=${translateText("private_menu.create")}
          width="block"
          ?disable=${this.busy}
          @click=${this.handleCreate}
        ></o-button>

        ${this.createdCode
          ? html`<p class="text-center text-white/80">
              ${translateText("private_menu.created_code")}:&nbsp;<strong
                class="font-mono tracking-[0.3em]"
                >${this.createdCode}</strong
              >
            </p>`
          : null}

        <div class="flex gap-2">
          <input
            type="text"
            inputmode="latin"
            autocapitalize="characters"
            autocomplete="off"
            spellcheck="false"
            .value=${this.roomCodeInput}
            placeholder=${translateText("private_menu.room_code_placeholder")}
            aria-label=${translateText("private_menu.room_code_label")}
            @input=${(e: Event) => {
              this.roomCodeInput = (e.target as HTMLInputElement).value;
              this.error = null;
            }}
            class="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 font-mono uppercase tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <o-button
            title=${translateText("private_menu.join")}
            ?disable=${this.busy}
            @click=${this.handleJoin}
          ></o-button>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-white/60">
              ${translateText("private_menu.pacing_label")}
            </span>
            <select
              .value=${this.pacing}
              @change=${(e: Event) =>
                (this.pacing = (e.target as HTMLSelectElement)
                  .value as MatchPacingPreset)}
              class="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-white"
            >
              ${MATCH_PACING_PRESETS.map(
                (preset) =>
                  html`<option
                    value=${preset}
                    class="bg-zinc-900"
                    ?selected=${preset === this.pacing}
                  >
                    ${translateText(`private_menu.pacing_${preset}`)}
                  </option>`,
              )}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-white/60">
              ${translateText("private_menu.map_label")}
            </span>
            <select
              .value=${this.map}
              @change=${(e: Event) =>
                (this.map = (e.target as HTMLSelectElement)
                  .value as GameMapType)}
              class="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-white"
            >
              ${maps.map(
                (info) =>
                  html`<option
                    value=${info.type}
                    class="bg-zinc-900"
                    ?selected=${info.type === this.map}
                  >
                    ${translateText(info.translationKey)}
                  </option>`,
              )}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-white/60">
              ${translateText("private_menu.bots_label")}
            </span>
            <input
              type="number"
              min="0"
              max="400"
              .value=${String(this.bots)}
              @input=${(e: Event) => {
                const next = Number((e.target as HTMLInputElement).value);
                this.bots = Number.isInteger(next)
                  ? Math.min(400, Math.max(0, next))
                  : 0;
              }}
              class="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-white"
            />
          </label>
        </div>

        ${this.error
          ? html`<p role="alert" class="text-center text-red-400 text-sm">
              ${this.error}
            </p>`
          : null}

        <div class="flex items-center justify-center gap-4 text-sm">
          <button
            class="text-white/60 hover:text-white underline"
            @click=${this.openSettings}
          >
            ${translateText("private_menu.settings")}
          </button>
          <span class="text-white/20" aria-hidden="true">•</span>
          <button
            class="text-white/60 hover:text-white underline"
            @click=${this.openCredits}
          >
            ${translateText("private_menu.credits")}
          </button>
        </div>
      </section>
    `;
  }
}
