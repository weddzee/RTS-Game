import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { EventBus } from "../../../core/EventBus";
import type { Controller } from "../../Controller";
import {
  type AirMission,
  type AirMissionType,
  type BomberTargetCategory,
  BOMBER_TARGET_CATEGORIES,
  WING_CREATION_COST,
  AIR_POINTS_PER_AIRCRAFT,
} from "../../../core/game/Aircraft";
import {
  airRegionLabel,
  airRegionLayoutFor,
} from "../../../core/game/AirRegion";
import {
  AirWingOrderIntentEvent,
  CreateAirWingIntentEvent,
  RenameAirWingIntentEvent,
} from "../../Transport";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

/**
 * The air wing panel (Prompt 7.2, 7.3, 7.5, 7.6).
 *
 * Deliberately a panel and not a map interaction. A wing has no position, so
 * there is nothing to click on the map and nothing to drag — which is the whole
 * design: aircraft are wings flying a mission over a region, not sprites you
 * move tile by tile. So the panel is where every air decision is made: raise a
 * wing, name it, station it in a region, and choose what it does there.
 *
 * The region list is derived from the same pure layout function the simulation
 * uses (airRegionLayoutFor over the map dimensions), so the regions offered here
 * are exactly the regions the sim validates against — there is no client-side
 * copy of the partition to drift out of sync.
 *
 * Everything is server-authoritative: the panel sends a type, a name, a region
 * and a mission category, and waits. It computes no damage and claims no
 * target.
 */
@customElement("air-wing-panel")
export class AirWingPanel extends LitElement implements Controller {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) eventBus: EventBus | null = null;
  // Bumped by the parent each tick so the readout advances.
  @property({ attribute: false }) refreshKey = 0;

  @state() private createType: "Fighter" | "Bomber" = "Fighter";
  @state() private editingName = false;
  @state() private nameDraft = "";

  // Light DOM so Tailwind classes apply, like the army panel.
  createRenderRoot() {
    return this;
  }

  /**
   * Cheap enough to re-render every tick: a wing's aircraft count changes once
   * per engagement wave, and the panel is small.
   */
  tick() {
    this.requestUpdate();
  }

  /** Aircraft the player's air factories have banked, and the wing's price. */
  private affordableAircraft(game: GameView): number {
    const me = game.myPlayer();
    if (me === null) return 0;
    return Math.floor(me.airCapacity() / AIR_POINTS_PER_AIRCRAFT);
  }

  private canAffordWing(game: GameView): boolean {
    const me = game.myPlayer();
    if (me === null) return false;
    return me.airCapacity() >= WING_CREATION_COST * AIR_POINTS_PER_AIRCRAFT;
  }

  private hasAirIndustry(game: GameView): boolean {
    // The panel says so rather than letting the player discover it by clicking
    // a button that is silently refused: 7.3's rule is structural, so it is
    // visible up front.
    const me = game.myPlayer();
    if (me === null) return false;
    return me.numTilesOwned() > 0 && this.airFactoryCount(game) > 0;
  }

  private airFactoryCount(game: GameView): number {
    const me = game.myPlayer();
    if (me === null) return 0;
    return me
      .units()
      .filter((u) => u.type() === "Factory" && (u as { factoryType?: string }).factoryType === "Air")
      .length;
  }

  /** Region ids for this map, derived exactly as the simulation derives them. */
  private regions(game: GameView): { id: number; label: string }[] {
    const layout = airRegionLayoutFor(game.width(), game.height());
    const out: { id: number; label: string }[] = [];
    for (let id = 0; id < layout.count; id++) {
      out.push({ id, label: airRegionLabel(layout, id) });
    }
    return out;
  }

  private raiseWing() {
    this.eventBus?.emit(
      new CreateAirWingIntentEvent(this.createType, null, null),
    );
  }

  private beginRename(current: string) {
    this.nameDraft = current;
    this.editingName = true;
  }

  private commitRename(wingId: number) {
    this.eventBus?.emit(
      new RenameAirWingIntentEvent(wingId, this.nameDraft),
    );
    this.editingName = false;
  }

  private order(wingId: number, regionId: number | null, mission: AirMission) {
    this.eventBus?.emit(new AirWingOrderIntentEvent(wingId, regionId, mission));
  }

  // -------------------------------------------------------------------------

  render() {
    const game = this.game;
    if (game === undefined || game.myPlayer() === null) {
      this.style.display = "none";
      return html``;
    }
    this.style.display = "block";

    const selected = game.selectedAirWing();
    const panel =
      "w-fit flex flex-col gap-2 py-2 px-4 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-bl-lg text-white text-sm";

    return html`
      <div class="${panel}">
        ${this.renderHeader(game)}
        ${selected === null ? this.renderCreateForm(game) : this.renderWing(game, selected)}
      </div>
    `;
  }

  private renderHeader(game: GameView) {
    const banked = this.affordableAircraft(game);
    return html`
      <div class="flex items-center justify-between gap-3">
        <span class="font-bold tracking-wide text-sky-300">
          ${translateText("air_wing_panel.title")}
        </span>
        <span class="text-gray-300">
          ${translateText("air_wing_panel.production", { aircraft: banked })}
        </span>
      </div>
      ${game.selectedAirWing() === null
        ? ""
        : html`<button
            type="button"
            class="self-start text-xs text-gray-400 hover:text-gray-200 cursor-pointer"
            @click=${() => game.setSelectedAirWing(null)}
          >
            ${translateText("air_wing_panel.close")}
          </button>`}
    `;
  }

  private renderCreateForm(game: GameView) {
    const hasIndustry = this.hasAirIndustry(game);
    const affordable = this.canAffordWing(game);
    const wings = game.myAirWings();

    return html`
      ${hasIndustry
        ? ""
        : html`<div class="text-xs text-amber-300">
            ${translateText("air_wing_panel.needs_air_factory")}
          </div>`}
      ${wings.length === 0
        ? ""
        : html`<div class="flex flex-col gap-1">
            ${wings.map(
              (w) => html`
                <button
                  type="button"
                  class="flex items-center justify-between gap-2 w-full text-left px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 cursor-pointer"
                  @click=${() => game.setSelectedAirWing(w.id)}
                >
                  <span class="font-semibold">${w.displayName()}</span>
                  <span class="text-xs text-gray-300">
                    ${w.aircraftCount()} ${translateText("air_wing_panel.aircraft")}
                    ${w.isAssigned() ? "" : ` · ${translateText("air_wing_panel.unassigned")}`}
                  </span>
                </button>
              `,
            )}
          </div>`}
      <div class="flex items-center gap-2">
        ${(["Fighter", "Bomber"] as const).map(
          (t) => html`
            <button
              type="button"
              class="px-2 py-1 rounded text-xs font-semibold cursor-pointer ${this.createType ===
              t
                ? "bg-sky-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"}"
              @click=${() => (this.createType = t)}
            >
              ${translateText(`air_wing_panel.types.${t}`)}
            </button>
          `,
        )}
        <button
          type="button"
          class="px-2 py-1 rounded text-xs font-semibold bg-emerald-700 text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          ?disabled=${!hasIndustry || !affordable}
          @click=${this.raiseWing}
        >
          ${translateText("air_wing_panel.raise", {
            cost: WING_CREATION_COST,
          })}
        </button>
      </div>
      ${hasIndustry && !affordable
        ? html`<div class="text-xs text-gray-400">
            ${translateText("air_wing_panel.need_production", {
              cost: WING_CREATION_COST,
            })}
          </div>`
        : ""}
    `;
  }

  private renderWing(game: GameView, wing: ReturnType<GameView["selectedAirWing"]>) {
    if (wing === null) return html``;
    const regions = this.regions(game);
    const mission = wing.mission();
    const fighter = wing.aircraftType() === "Fighter";

    return html`
      <div class="flex items-center justify-between gap-3">
        ${this.editingName
          ? html`
              <input
                class="bg-gray-900 text-white rounded px-1 py-0.5 text-sm w-40"
                .value=${this.nameDraft}
                maxlength="32"
                @change=${(e: Event) =>
                  (this.nameDraft = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") this.commitRename(wing.id);
                  if (e.key === "Escape") this.editingName = false;
                }}
              />
              <button
                type="button"
                class="text-xs text-sky-300 hover:text-sky-200 cursor-pointer"
                @click=${() => this.commitRename(wing.id)}
              >
                ${translateText("air_wing_panel.save")}
              </button>
            `
          : html`
              <button
                type="button"
                class="font-bold text-sky-300 hover:underline cursor-pointer"
                @click=${() => this.beginRename(wing.displayName())}
              >
                ${wing.displayName()}
              </button>
            `}
        <span class="text-xs text-gray-300">
          ${translateText(`air_wing_panel.types.${wing.aircraftType()}`)}
        </span>
      </div>

      <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-gray-300">
        <span>${translateText("air_wing_panel.aircraft")}</span>
        <span class="text-right text-white">${wing.aircraftCount()}</span>
        <span>${translateText("air_wing_panel.losses")}</span>
        <span class="text-right text-white">${wing.losses()}</span>
        <span>${translateText("air_wing_panel.experience")}</span>
        <span class="text-right text-white">${wing.experience()}</span>
        <span>${translateText("air_wing_panel.effectiveness")}</span>
        <span class="text-right text-white">${wing.effectiveness()}%</span>
      </div>

      ${this.renderMissionPicker(game, wing, fighter, mission)}
      ${this.renderRegionPicker(game, wing, regions)}

      <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-gray-400">
        <span>${translateText("air_wing_panel.engagements")}</span>
        <span class="text-right">${wing.statistics().engagements}</span>
        <span>${translateText("air_wing_panel.destroyed")}</span>
        <span class="text-right">${wing.statistics().aircraftDestroyed}</span>
        <span>${translateText("air_wing_panel.strikes")}</span>
        <span class="text-right">${wing.statistics().strikesLanded}</span>
      </div>
    `;
  }

  private renderMissionPicker(
    game: GameView,
    wing: NonNullable<ReturnType<GameView["selectedAirWing"]>>,
    fighter: boolean,
    mission: AirMission,
  ) {
    const options: AirMissionType[] = fighter
      ? ["airSuperiority", "intercept"]
      : ["strike"];
    return html`
      <div class="flex flex-col gap-1">
        <span class="text-xs uppercase tracking-wide text-gray-400">
          ${translateText("air_wing_panel.mission")}
        </span>
        ${options.map(
          (type) => html`
            <button
              type="button"
              class="flex items-center justify-between gap-2 w-full text-left px-2 py-1 rounded text-xs cursor-pointer ${mission.type ===
              type
                ? "bg-sky-700 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"}"
              @click=${() => {
                if (type === "strike") {
                  this.order(wing.id, wing.regionId(), {
                    type: "strike",
                    target: (mission as { target?: BomberTargetCategory }).target ?? "militaryIndustry",
                  });
                } else {
                  this.order(wing.id, wing.regionId(), { type });
                }
              }}
            >
              <span>${translateText(`air_wing_panel.missions.${type}`)}</span>
            </button>
          `,
        )}
        ${mission.type === "strike"
          ? html`
              <div class="flex flex-wrap gap-1 pl-2">
                ${BOMBER_TARGET_CATEGORIES.map(
                  (target) => html`
                    <button
                      type="button"
                      class="px-1.5 py-0.5 rounded text-[10px] cursor-pointer ${mission
                        .type === "strike" && mission.target === target
                        ? "bg-amber-700 text-white"
                        : "bg-gray-700 text-gray-400 hover:bg-gray-600"}"
                      @click=${() =>
                        this.order(wing.id, wing.regionId(), {
                          type: "strike",
                          target,
                        })}
                    >
                      ${translateText(`air_wing_panel.targets.${target}`)}
                    </button>
                  `,
                )}
              </div>
            `
          : ""}
      </div>
    `;
  }

  private renderRegionPicker(
    game: GameView,
    wing: NonNullable<ReturnType<GameView["selectedAirWing"]>>,
    regions: { id: number; label: string }[],
  ) {
    const current = wing.regionId();
    return html`
      <div class="flex flex-col gap-1">
        <span class="text-xs uppercase tracking-wide text-gray-400">
          ${translateText("air_wing_panel.region")}
        </span>
        <div class="flex flex-wrap gap-1">
          ${regions.map(
            (r) => html`
              <button
                type="button"
                class="px-1.5 py-0.5 rounded text-[10px] cursor-pointer ${current ===
                r.id
                  ? "bg-emerald-700 text-white"
                  : "bg-gray-700 text-gray-400 hover:bg-gray-600"}"
                @click=${() =>
                  this.order(wing.id, r.id, wing.mission())}
              >
                ${r.label}
              </button>
            `,
          )}
          ${current === null
            ? ""
            : html`
                <button
                  type="button"
                  class="px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-400 hover:bg-gray-600 cursor-pointer"
                  @click=${() => this.order(wing.id, null, wing.mission())}
                >
                  ${translateText("air_wing_panel.unassign")}
                </button>
              `}
        </div>
      </div>
    `;
  }
}