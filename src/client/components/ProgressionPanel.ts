import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { EventBus } from "../../core/EventBus";
import {
  levelUpPanelFor,
  PROGRESSION_MAX_LEVEL,
  xpProgressPercent,
  xpToNextLevel,
} from "../../core/game/Progression";
import { ChoosePerkIntentEvent } from "../Transport";
import { translateText } from "../Utils";
import { GameView } from "../view";

/**
 * The per-match level readout and level-up picker (Prompt 6, 6.5).
 *
 * Deliberately NOT a modal. 6.5 asks for a quick choice with no full-screen
 * interruption during active fighting unless the player asks for one, so this is
 * a corner panel in the same stack as the game timer:
 *
 *   - A permanent one-line badge: "LV 4" plus an XP bar. It is the level's
 *     only always-on surface and costs a few pixels.
 *   - A choice list the player opens by clicking the badge, and closes again
 *     with "Later" — the pick stays pending in the simulation either way, so
 *     someone can fight a push, finish it, and choose afterwards.
 *   - Nothing blocks the map. The panel never covers the map centre, never
 *     takes focus, and never opens itself over a fight.
 *
 * Everything shown comes from state the simulation already pushed on the
 * PlayerUpdate; this component computes no progression rules of its own. It
 * sends a bare perk ID and waits for the sim to confirm, so a click on a stale
 * panel (the pick was already made in another tab) simply does nothing.
 */
@customElement("progression-panel")
export class ProgressionPanel extends LitElement {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) eventBus: EventBus | null = null;
  @property({ attribute: false }) hasWinner = false;
  // Bumped by the parent each tick so the XP bar advances.
  @property({ attribute: false }) refreshKey = 0;

  // Whether the choice list is expanded. Default collapsed: the panel must not
  // open itself over a fight, and 6.5 says the player opens it.
  @state() private expanded = false;
  // The pending set this expansion was opened for. If the sim's pending set
  // changes under us (a level-up while the list was closed, or the pick landed),
  // the stale expansion is dropped rather than showing options that are no
  // longer on offer.
  private expandedFor = "";

  // Light DOM so Tailwind classes apply and it stacks in the parent's flex.
  createRenderRoot() {
    return this;
  }

  private pendingKey(): string {
    const me = this.game?.myPlayer();
    if (me === undefined || me === null) return "";
    return me.pendingPerkChoices().join("|");
  }

  private toggle = () => {
    const key = this.pendingKey();
    if (key === "") return;
    this.expanded = !this.expanded;
    this.expandedFor = this.expanded ? key : "";
  };

  private select(perkId: string) {
    // Emit and wait. The sim applies the perk and pushes the new state; this
    // component deliberately does not optimistically mark it as chosen, so a
    // refused pick shows up as "still pending" instead of a lie.
    this.eventBus?.emit(new ChoosePerkIntentEvent(perkId));
    this.expanded = false;
    this.expandedFor = "";
  }

  render() {
    const me = this.game?.myPlayer();
    // Hidden with no player (spectator, or the lobby has not produced one) and
    // before the player has spawned: levels are personal, so there is nothing to
    // show, and a "LV 1" badge during the spawn phase would only be noise. Once
    // a winner is declared the panel goes away with the rest of the HUD.
    const visible =
      !!me && me.hasSpawned() && !this.hasWinner && !me.isDisconnected();
    this.style.display = visible ? "block" : "none";
    if (!visible || me === undefined) return html``;

    const level = Math.max(1, Math.min(PROGRESSION_MAX_LEVEL, me.matchLevel()));
    const xp = me.matchXP();
    const panel = levelUpPanelFor(me);
    const pendingKey = this.pendingKey();

    // Drop an expansion whose options the sim has since replaced or consumed.
    if (this.expanded && this.expandedFor !== pendingKey) {
      this.expanded = false;
      this.expandedFor = "";
    }

    const maxed = level >= PROGRESSION_MAX_LEVEL;

    return html`
      <div
        class="w-fit flex flex-col gap-1.5 py-2 px-4 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-bl-lg text-white text-sm"
      >
        <button
          type="button"
          class="flex items-center gap-2 w-full text-left ${panel === null
            ? "cursor-default"
            : "cursor-pointer"}"
          @click=${this.toggle}
          title=${panel === null
            ? ""
            : translateText("progression.choose_doctrine")}
        >
          <span class="font-bold tracking-wide text-sky-300">
            ${translateText("progression.level_badge", { level })}
          </span>
          ${panel === null
            ? nothing
            : html`<span class="relative flex h-2 w-2">
                <span
                  class="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"
                ></span>
                <span
                  class="relative inline-flex rounded-full h-2 w-2 bg-sky-400"
                ></span>
              </span>`}
          ${maxed
            ? html`<span class="text-amber-300">
                ${translateText("progression.max_level")}
              </span>`
            : html`<span class="ml-auto text-gray-400">
                ${translateText("progression.xp_to_next", {
                  xp: xpToNextLevel(xp),
                })}
              </span>`}
        </button>

        <div class="relative h-2.5 w-52 overflow-hidden rounded bg-gray-600/60">
          <div
            class="absolute inset-y-0 left-0 ${maxed
              ? "bg-amber-400"
              : "bg-sky-400"}"
            style="width:${xpProgressPercent(xp)}%"
          ></div>
        </div>

        ${this.expanded && panel !== null
          ? this.renderChoices(panel.level, panel.choices)
          : nothing}
      </div>
    `;
  }

  private renderChoices(
    level: number,
    choices: {
      id: string;
      doctrine: string;
      nameKey: string;
      descKey: string;
    }[],
  ) {
    return html`
      <div class="mt-1 flex flex-col gap-1.5 border-t border-gray-600 pt-2">
        <div class="font-bold tracking-wide text-amber-300">
          ${translateText("progression.level_up_title", { level })}
        </div>
        <div class="text-xs text-gray-300">
          ${translateText("progression.choose_one")}
        </div>
        ${choices.map(
          (choice) => html`
            <button
              type="button"
              class="flex flex-col gap-0.5 w-full text-left px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 cursor-pointer"
              @click=${() => this.select(choice.id)}
            >
              <span class="font-semibold text-white">
                ${translateText(choice.nameKey)}
              </span>
              <span class="text-xs text-gray-300">
                ${translateText(choice.descKey)}
              </span>
              <span class="text-[10px] uppercase tracking-wide text-sky-300">
                ${translateText(`progression.doctrines.${choice.doctrine}`)}
              </span>
            </button>
          `,
        )}
        <button
          type="button"
          class="w-full text-xs text-gray-400 hover:text-gray-200 cursor-pointer"
          @click=${this.toggle}
        >
          ${translateText("progression.decide_later")}
        </button>
      </div>
    `;
  }
}
