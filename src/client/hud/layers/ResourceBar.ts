import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { AIR_POINTS_PER_AIRCRAFT } from "../../../core/game/Aircraft";
import type { Controller } from "../../Controller";
import { renderNumber } from "../../Utils";
import { GameView } from "../../view";

/**
 * Prompt 10.2: Top resource bar showing only important information.
 *
 * Display-only: every figure is read straight from the authoritative view
 * (gold, troops, troop ceiling, banked aircraft, match level/XP and the
 * match clock), so the bar can never disagree with the rest of the HUD.
 */
@customElement("resource-bar")
export class ResourceBar extends LitElement implements Controller {
  @property({ attribute: false }) game!: GameView;
  @property({ type: Boolean }) showTimer: boolean = true;

  // Light DOM so Tailwind classes apply, like the other HUD panels.
  createRenderRoot() {
    return this;
  }

  /** Refresh with the game tick so gold/troops/XP advance live. */
  tick() {
    this.requestUpdate();
  }

  render(): TemplateResult {
    const me = this.game?.myPlayer() ?? null;
    // Hidden with no player (spectator, or the lobby has not produced one) and
    // before the player has spawned: the figures are meaningless there, and a
    // row of zeros during the spawn phase would only be noise.
    const visible = me !== null && me.hasSpawned();
    this.style.display = visible ? "block" : "none";
    if (me === null || !me.hasSpawned()) return html``;

    const elapsed = Math.floor(this.game.elapsedGameSeconds());
    const timerMinutes = Math.floor(elapsed / 60);
    const timerSeconds = elapsed % 60;

    return html`
      <div
        class="resource-bar bg-zinc-900/95 border-b border-white/10 backdrop-blur-sm sticky top-0 left-0 right-0 z-50 px-4 py-3 shadow-sm"
      >
        <div class="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 text-xs">💲</span>
            <span class="text-zinc-300 font-medium text-sm"
              >${renderNumber(me.gold())}</span
            >
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 text-xs">👥</span>
            <span class="text-zinc-300 font-medium text-sm"
              >${me.troops()}</span
            >
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 text-xs">⚙️</span>
            <span class="text-zinc-300 font-medium text-sm"
              >${this.game.config().maxTroops(me)}</span
            >
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 text-xs">🛩️</span>
            <span class="text-zinc-300 font-medium text-sm"
              >${Math.floor(me.airCapacity() / AIR_POINTS_PER_AIRCRAFT)}</span
            >
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 text-xs">📈</span>
            <span class="text-zinc-300 font-medium text-sm">
              Lvl ${me.matchLevel()} (${me.matchXP()})
            </span>
          </div>
          ${this.showTimer
            ? html`
                <div class="flex items-center gap-2">
                  <span class="text-zinc-400 text-xs">⏰</span>
                  <span class="text-zinc-300 font-medium text-sm">
                    ${timerMinutes}:${timerSeconds.toString().padStart(2, "0")}
                  </span>
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }
}