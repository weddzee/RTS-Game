// ArmyPanel â€” the in-game panel for one army (Prompt 3.5).
//
// Opened by clicking an army on the map (see ArmySelectionController). Shows
// the army's name, strength, composition, veterancy, supply, current order,
// commander placeholder and career statistics, and issues the seven orders:
// Move, Create Front, Draw Offensive, Hold, Stop, Rename, Edit Composition.
//
// Light DOM (createRenderRoot returns this) so the Tailwind classes below
// apply, matching the other HUD panels. Every action emits an intent and then
// waits: the panel renders what the simulation says on the next tick, never
// what the button press hoped for.

import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import type { ArmyOrder } from "../../../core/game/Army";
import {
  ARMY_CATEGORIES,
  ARMY_PRESETS,
  type ArmyComposition,
  matchingPreset,
  normalizeComposition,
  presetComposition,
} from "../../../core/game/ArmyComposition";
import {
  ARMY_NAME_MAX_LENGTH,
  type ArmyNameRejection,
  validateArmyName,
} from "../../../core/game/ArmyName";
import { xpProgress } from "../../../core/game/ArmyVeterancy";
import type { Controller } from "../../Controller";
import type {
  PendingArmyCreation,
  PendingArmyOrder,
} from "../../controllers/ArmySelectionController";
import type { BattlePlanDrawMode } from "../../controllers/BattlePlanController";
import {
  ArmyOrderIntentEvent,
  BattlePlanIntentEvent,
  RenameArmyIntentEvent,
  SetArmyCompositionIntentEvent,
} from "../../Transport";
import { renderTroops, translateText } from "../../Utils";
import type { GameView } from "../../view";
import type { ArmyView } from "../../view/ArmyView";
import type { BattlePlanView } from "../../view/BattlePlanView";

@customElement("army-panel")
export class ArmyPanel extends LitElement implements Controller {
  @property({ attribute: false }) game: GameView | null = null;
  @property({ attribute: false }) eventBus: EventBus | null = null;
  /** Shared with ArmySelectionController so the buttons and the picker agree. */
  @property({ attribute: false }) selection: {
    pendingOrder(): PendingArmyOrder | null;
    requestTile(kind: Exclude<PendingArmyOrder, "create">): void;
    requestCreate(creation: PendingArmyCreation): void;
    cancel(): void;
  } | null = null;
  /**
   * The drawing controller (Prompt 4). Declared as a shape rather than the class
   * so the panel can be unit-tested against a stub, exactly like `selection`.
   */
  @property({ attribute: false }) plans: {
    armedMode(): BattlePlanDrawMode | null;
    isDrawing(): boolean;
    arm(mode: BattlePlanDrawMode): void;
    cancel(): void;
  } | null = null;

  @state() private editingName = false;
  @state() private nameDraft = "";
  @state() private editingComposition = false;
  @state() private compositionDraft: ArmyComposition | null = null;
  /** Troop share of the free pool for the creation form, in percent. */
  @state() private createPercent = 50;
  /** Starting composition for the creation form. */
  @state() private createComposition: ArmyComposition =
    presetComposition("balanced");

  private renameError: string | null = null;

  createRenderRoot() {
    return this;
  }

  tick() {
    // Cheap enough to just re-render: the panel is hidden most of the time, and
    // its contents change whenever the army does.
    this.requestUpdate();
  }

  render() {
    const game = this.game;
    if (!game) {
      // Leaving a half-typed name behind when the panel closes would be rude.
      this.editingName = false;
      this.editingComposition = false;
      return nothing;
    }
    const army = game.selectedArmy();
    if (army !== null && army.isMine(game)) {
      return this.renderArmyPanel(army);
    }
    // No army selected: offer to raise one. This is the only entry point to
    // army creation (Prompt 3.4), so it lives here rather than in the map
    // chrome â€” an army is mustered from the player's own territory, and this
    // is where the player can already see their troop pool and army cap.
    this.editingName = false;
    this.editingComposition = false;
    return this.renderCreateForm();
  }

  private renderArmyPanel(army: ArmyView) {
    return html`
      <div
        class="pointer-events-auto w-80 max-w-[92vw] rounded-xl bg-zinc-900/95 ring-1 ring-white/10 shadow-2xl text-zinc-200 text-sm"
        role="dialog"
        aria-label=${translateText("army_panel.title")}
      >
        ${this.renderHeader(army)} ${this.renderVitals(army)}
        ${this.editingComposition
          ? this.renderCompositionEditor(army)
          : this.renderComposition(army)}
        ${this.renderStats(army)} ${this.renderOrders(army)}
        ${this.renderPlans()}
      </div>
    `;
  }

  /**
   * The creation form: how many troops to commit, a name if you want one, and
   * a starting composition.
   *
   * The troop slider is a share of the free pool rather than an absolute
   * number, so it stays meaningful as the pool grows, and it is capped by
   * `Config.maxArmyStrength` â€” the same ceiling the server enforces, so the
   * button is never a request the simulation will refuse.
   */
  private renderCreateForm() {
    const game = this.game;
    const me = game?.myPlayer() ?? null;
    if (
      game === null ||
      me === null ||
      game.inSpawnPhase() ||
      !me.isAlive() ||
      !me.hasSpawned()
    ) {
      return nothing;
    }
    const available = Number(me.troops());
    const ceiling = Math.floor(game.config().maxArmyStrength(me));
    const mine = game.myArmies().length;
    const cap = game.config().maxArmyCount(me);
    if (available < 1) return nothing;
    if (mine >= cap) {
      return html`
        <div
          class="pointer-events-auto w-80 max-w-[92vw] rounded-xl bg-zinc-900/95 ring-1 ring-white/10 p-3 text-sm text-zinc-300 shadow-2xl"
          role="dialog"
        >
          ${translateText("army_panel.at_cap", { cap })}
        </div>
      `;
    }

    const percent = Math.min(100, Math.max(1, this.createPercent));
    const troops = Math.max(
      1,
      Math.min(ceiling, Math.floor((available * percent) / 100)),
    );

    return html`
      <div
        class="pointer-events-auto w-80 max-w-[92vw] rounded-xl bg-zinc-900/95 ring-1 ring-white/10 text-zinc-200 text-sm shadow-2xl"
        role="dialog"
        aria-label=${translateText("army_panel.create_title")}
      >
        <div class="border-b border-white/10 px-3 py-2 font-semibold">
          ${translateText("army_panel.create_title")}
        </div>
        <div class="px-3 py-2">
          <div class="mb-1 flex items-center justify-between text-xs">
            <span class="text-zinc-400"
              >${translateText("army_panel.create_troops")}</span
            >
            <span class="tabular-nums">${renderTroops(troops)}</span>
          </div>
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            class="w-full accent-emerald-500"
            .value=${String(percent)}
            @input=${(e: Event) => {
              this.createPercent = Number((e.target as HTMLInputElement).value);
            }}
          />
          <div class="mt-0.5 flex justify-between text-[10px] text-zinc-500">
            <span
              >${translateText("army_panel.create_available", {
                troops: renderTroops(available),
              })}</span
            >
            <span
              >${translateText("army_panel.create_ceiling", {
                troops: renderTroops(ceiling),
              })}</span
            >
          </div>

          <label class="mt-2 flex flex-col gap-1 text-xs">
            <span class="text-zinc-400"
              >${translateText("army_panel.name_optional")}</span
            >
            <input
              class="rounded bg-zinc-800 px-2 py-1 outline-none ring-1 ring-white/20 focus:ring-white/40"
              maxlength=${ARMY_NAME_MAX_LENGTH}
              .value=${this.nameDraft}
              @input=${(e: Event) => {
                this.nameDraft = (e.target as HTMLInputElement).value;
              }}
              placeholder=${translateText("army_panel.create_name_placeholder")}
            />
          </label>

          <div class="mt-2 flex flex-wrap gap-1">
            ${ARMY_PRESETS.map(
              (p) => html`
                <button
                  class="rounded px-2 py-0.5 text-xs ${matchingPreset(
                    this.createComposition,
                  ) === p
                    ? "bg-white/20 text-white"
                    : "bg-white/5 text-zinc-400 hover:text-zinc-100"}"
                  @click=${() => {
                    this.createComposition = presetComposition(p);
                  }}
                >
                  ${translateText(`army_panel.preset.${p}`)}
                </button>
              `,
            )}
          </div>

          ${this.renameError === null
            ? nothing
            : html`<p class="mt-1 text-xs text-red-400">
                ${translateText(this.renameError)}
              </p>`}
        </div>
        <div
          class="flex items-center justify-between border-t border-white/10 px-3 py-2"
        >
          <span class="text-xs text-zinc-500"
            >${translateText("army_panel.create_count", {
              count: mine,
              cap,
            })}</span
          >
          <button
            class="rounded bg-emerald-600 px-3 py-1 font-medium hover:bg-emerald-500"
            @click=${() => this.createArmy(troops)}
          >
            ${translateText("army_panel.create_action")}
          </button>
        </div>
        ${this.selection?.pendingOrder() === "create"
          ? html`<p
              class="border-t border-white/10 px-3 py-1.5 text-xs text-amber-300"
            >
              ${translateText("army_panel.pick_tile.create")}
            </p>`
          : nothing}
      </div>
    `;
  }

  /**
   * Send the creation request. The name is validated locally for immediate
   * feedback; the simulation validates again and falls back to a generated
   * default if it disagrees.
   *
   * The tile is the next map click, so the player chooses where the army
   * mustered â€” an army forms on your own ground, and making that a deliberate
   * click means the panel and the rules can never disagree about it.
   */
  private createArmy(troops: number): void {
    if (this.selection === null) return;
    const trimmed = this.nameDraft.trim();
    let name: string | null = null;
    if (trimmed.length > 0) {
      const result = validateArmyName(trimmed);
      if (!result.ok) {
        this.renameError = this.nameErrorKey(result.reason);
        return;
      }
      name = result.name;
    }
    this.renameError = null;
    this.selection.requestCreate({
      troops,
      name,
      composition: { ...this.createComposition },
    });
  }

  private renderHeader(army: ArmyView) {
    return html`
      <div class="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        ${this.editingName
          ? html`
              <input
                class="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-sm outline-none ring-1 ring-white/20 focus:ring-white/40"
                maxlength=${ARMY_NAME_MAX_LENGTH}
                .value=${this.nameDraft}
                @input=${(e: Event) => {
                  this.nameDraft = (e.target as HTMLInputElement).value;
                  this.renameError = null;
                }}
                @keydown=${this.onNameKeydown}
                placeholder=${translateText("army_panel.name_placeholder")}
              />
              <button
                class="rounded bg-emerald-600 px-2 py-1 text-xs font-medium hover:bg-emerald-500"
                @click=${() => this.commitRename(army)}
              >
                ${translateText("army_panel.save")}
              </button>
              <button
                class="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                @click=${() => {
                  this.editingName = false;
                  this.renameError = null;
                }}
              >
                ${translateText("army_panel.cancel")}
              </button>
            `
          : html`
              <span class="min-w-0 flex-1 truncate font-semibold">
                ${army.name()}
              </span>
              <button
                class="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100"
                @click=${() => this.beginRename(army)}
              >
                ${translateText("army_panel.rename")}
              </button>
            `}
      </div>
      ${this.renameError === null
        ? nothing
        : html`<p class="px-3 pt-1 text-xs text-red-400">
            ${translateText(this.renameError)}
          </p>`}
    `;
  }

  private renderVitals(army: ArmyView) {
    const progress = xpProgress(army.xp());
    const tier = translateText(`army_panel.tier.${army.tier()}`);
    return html`
      <div class="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2">
        <div>
          <span class="text-zinc-400"
            >${translateText("army_panel.strength")}</span
          >
          <span class="ml-1 font-medium tabular-nums">
            ${renderTroops(army.strength())}
          </span>
        </div>
        <div>
          <span class="text-zinc-400"
            >${translateText("army_panel.veterancy")}</span
          >
          <span class="ml-1 font-medium">${tier}</span>
        </div>
        <div>
          <span class="text-zinc-400"
            >${translateText("army_panel.supply")}</span
          >
          <span
            class="ml-1 font-medium tabular-nums ${this.supplyColorClass(army)}"
            >${translateText(`army_panel.supply_status.${army.supplyStatus()}`)}
            (${Math.round(army.supply())}%)</span
          >
        </div>
        <div>
          <span class="text-zinc-400"
            >${translateText("army_panel.organization")}</span
          >
          <span class="ml-1 font-medium tabular-nums"
            >${Math.round(army.organization())}%</span
          >
        </div>
        <div class="col-span-2">
          <div class="flex items-center gap-2">
            <span class="shrink-0 text-zinc-400"
              >${translateText("army_panel.experience")}</span
            >
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                class="h-full rounded-full bg-amber-400 transition-[width] duration-200"
                style="width: ${progress.atMaxTier
                  ? 100
                  : Math.round((progress.intoTier / progress.tierSpan) * 100)}%"
              ></div>
            </div>
          </div>
        </div>
        <div class="col-span-2">
          <span class="text-zinc-400"
            >${translateText("army_panel.order")}</span
          >
          <span class="ml-1 font-medium">${this.orderLabel(army)}</span>
        </div>
        <div class="col-span-2">
          <span class="text-zinc-400"
            >${translateText("army_panel.commander")}</span
          >
          <span class="ml-1 text-zinc-500"
            >${translateText("army_panel.commander_unassigned")}</span
          >
        </div>
      </div>
    `;
  }

  private renderComposition(army: ArmyView) {
    const c = army.composition();
    return html`
      <div class="border-t border-white/10 px-3 py-2">
        <div class="mb-1 flex items-center justify-between">
          <span class="text-zinc-400"
            >${translateText("army_panel.composition")}</span
          >
          <button
            class="rounded px-2 py-0.5 text-xs text-zinc-400 hover:text-zinc-100"
            @click=${() => this.beginCompositionEdit(army)}
          >
            ${translateText("army_panel.edit_composition")}
          </button>
        </div>
        <div class="flex h-2 w-full overflow-hidden rounded-full bg-white/10">
          ${ARMY_CATEGORIES.map(
            (k) => html`
              <div
                class="h-full ${this.categoryColor(k)}"
                style="width: ${c[k]}%"
                title="${translateText(`army_panel.category.${k}`)}: ${c[k]}%"
              ></div>
            `,
          )}
        </div>
        <div class="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-400">
          ${ARMY_CATEGORIES.map(
            (k) =>
              html`<span
                ><span
                  class="mr-1 inline-block h-1.5 w-1.5 rounded-full ${this.categoryColor(
                    k,
                  )}"
                ></span
                >${translateText(`army_panel.category.${k}`)} ${c[k]}%</span
              >`,
          )}
        </div>
      </div>
    `;
  }

  private renderCompositionEditor(army: ArmyView) {
    const draft = this.compositionDraft ?? army.composition();
    return html`
      <div class="border-t border-white/10 px-3 py-2">
        <div class="mb-2 flex flex-wrap gap-1">
          ${ARMY_PRESETS.map(
            (p) => html`
              <button
                class="rounded px-2 py-0.5 text-xs ${matchingPreset(draft) === p
                  ? "bg-white/20 text-white"
                  : "bg-white/5 text-zinc-400 hover:text-zinc-100"}"
                @click=${() => {
                  this.compositionDraft = presetComposition(p);
                }}
              >
                ${translateText(`army_panel.preset.${p}`)}
              </button>
            `,
          )}
        </div>
        ${ARMY_CATEGORIES.map(
          (k) => html`
            <label class="mb-1 flex items-center gap-2 text-xs">
              <span class="w-20 shrink-0 text-zinc-400"
                >${translateText(`army_panel.category.${k}`)}</span
              >
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                class="flex-1 accent-emerald-500"
                .value=${String(draft[k])}
                @input=${(e: Event) => {
                  const next = {
                    ...draft,
                    [k]: Number((e.target as HTMLInputElement).value),
                  };
                  this.compositionDraft = normalizeComposition(next);
                }}
              />
              <span class="w-9 shrink-0 text-right tabular-nums"
                >${draft[k]}%</span
              >
            </label>
          `,
        )}
        <div class="mt-2 flex items-center justify-between text-xs">
          <span class="text-zinc-500"
            >${translateText("army_panel.composition_hint")}</span
          >
          <span class="flex gap-1">
            <button
              class="rounded bg-emerald-600 px-2 py-1 font-medium hover:bg-emerald-500"
              @click=${() => this.commitComposition(army)}
            >
              ${translateText("army_panel.apply")}
            </button>
            <button
              class="rounded px-2 py-1 text-zinc-400 hover:text-zinc-200"
              @click=${() => {
                this.editingComposition = false;
                this.compositionDraft = null;
              }}
            >
              ${translateText("army_panel.cancel")}
            </button>
          </span>
        </div>
      </div>
    `;
  }

  private renderStats(army: ArmyView) {
    const s = army.statistics();
    const rows: [string, string][] = [
      [
        "army_panel.stat.battles",
        `${translateText("army_panel.stat.battles_won", {
          won: s.battlesWon,
          fought: s.battlesFought,
        })}`,
      ],
      [
        "army_panel.stat.casualties_inflicted",
        renderTroops(s.casualtiesInflicted),
      ],
      ["army_panel.stat.casualties_taken", renderTroops(s.casualtiesTaken)],
      ["army_panel.stat.tiles_captured", `${s.tilesCaptured}`],
    ];
    return html`
      <div class="border-t border-white/10 px-3 py-2 text-xs">
        <div class="mb-1 text-zinc-400">
          ${translateText("army_panel.battle_record")}
        </div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-0.5">
          ${rows.map(
            ([key, value]) => html`
              <div class="flex justify-between">
                <span class="text-zinc-500">${translateText(key)}</span>
                <span class="tabular-nums">${value}</span>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderOrders(army: ArmyView) {
    const pending = this.selection?.pendingOrder() ?? null;
    const busy = (kind: PendingArmyOrder) => pending === kind;
    return html`
      <div class="border-t border-white/10 px-3 py-2">
        <div class="mb-1 text-zinc-400">
          ${translateText("army_panel.orders")}
        </div>
        <div class="grid grid-cols-3 gap-1 text-xs">
          <button
            class=${this.orderButtonClass(busy("move"))}
            @click=${() => this.selection?.requestTile("move")}
          >
            ${translateText("army_panel.order_move")}
          </button>
          <button
            class=${this.orderButtonClass(busy("createFront"))}
            @click=${() => this.selection?.requestTile("createFront")}
          >
            ${translateText("army_panel.order_create_front")}
          </button>
          <button
            class=${this.orderButtonClass(busy("attack"))}
            @click=${() => this.selection?.requestTile("attack")}
          >
            ${translateText("army_panel.order_offensive")}
          </button>
          <button
            class=${this.orderButtonClass(false)}
            @click=${() => this.sendOrder(army, { type: "hold" })}
          >
            ${translateText("army_panel.order_hold")}
          </button>
          <button
            class=${this.orderButtonClass(false)}
            @click=${() => this.sendOrder(army, { type: "stop" })}
          >
            ${translateText("army_panel.order_stop")}
          </button>
          <button
            class=${this.orderButtonClass(false)}
            @click=${() => this.beginRename(army)}
          >
            ${translateText("army_panel.rename")}
          </button>
        </div>
        ${pending === null
          ? nothing
          : html`<p class="mt-1.5 text-xs text-amber-300">
              ${translateText(`army_panel.pick_tile.${pending}`)}
            </p>`}
      </div>
    `;
  }

  /**
   * The drawn-order buttons (Prompt 4.1).
   *
   * These arm a *gesture* rather than resolving to a tile, which is why they live
   * on the controller and not here: the panel only has to say which kind of line
   * the player is about to draw. The `hold` button is separate because hold is an
   * instruction, not a thing to draw.
   */
  private renderPlans() {
    const armed = this.plans?.armedMode() ?? null;
    const plan = this.game?.selectedBattlePlan() ?? null;
    const drawing = (kind: BattlePlanDrawMode) =>
      this.orderButtonClass(armed === kind);
    return html`
      <div class="border-t border-white/10 px-3 py-2">
        <div class="mb-1 text-zinc-400">
          ${translateText("battle_plan.title")}
        </div>
        <div class="grid grid-cols-2 gap-1 text-xs">
          <button
            class=${drawing("frontline")}
            @click=${() => this.plans?.arm("frontline")}
          >
            ${translateText("battle_plan.order_frontline")}
          </button>
          <button
            class=${drawing("offensive")}
            @click=${() => this.plans?.arm("offensive")}
          >
            ${translateText("battle_plan.order_offensive")}
          </button>
          <button
            class=${drawing("spearhead")}
            @click=${() => this.plans?.arm("spearhead")}
          >
            ${translateText("battle_plan.order_spearhead")}
          </button>
          <button
            class=${drawing("fallback")}
            @click=${() => this.plans?.arm("fallback")}
          >
            ${translateText("battle_plan.order_fallback")}
          </button>
          <button
            class=${this.orderButtonClass(false)}
            @click=${() => this.pauseSelectedPlan()}
          >
            ${translateText("battle_plan.pause")}
          </button>
          <button
            class=${this.orderButtonClass(false)}
            @click=${() => this.deleteSelectedPlan()}
          >
            ${translateText("battle_plan.delete")}
          </button>
        </div>
        ${armed !== null
          ? html`<p class="mt-1.5 text-xs text-amber-300">
              ${translateText(`battle_plan.drawing.${armed}`)}
            </p>`
          : plan === null
            ? nothing
            : this.renderPlanStatus(plan)}
      </div>
    `;
  }

  private renderPlanStatus(plan: BattlePlanView) {
    const running = plan.isRunning();
    return html`
      <div class="mt-2 space-y-1 text-xs">
        <p class="text-zinc-400">
          ${translateText(`battle_plan.kind.${plan.kind()}`)}
          Â·
          ${translateText(`battle_plan.status.${plan.status()}`)}
        </p>
        <p class="text-zinc-500">
          ${translateText("battle_plan.summary", {
            frontier: plan.frontier.length >> 1,
            route: plan.route.length >> 1,
            armies: plan.armyIDs.length,
          })}
        </p>
        ${running
          ? nothing
          : html`<button
              class=${this.orderButtonClass(false)}
              @click=${() => this.resumeSelectedPlan()}
            >
              ${translateText("battle_plan.resume")}
            </button>`}
      </div>
    `;
  }

  // --- actions -----------------------------------------------------------

  private sendOrder(army: ArmyView, order: ArmyOrder): void {
    this.selection?.cancel();
    this.eventBus?.emit(new ArmyOrderIntentEvent(army.id, order));
  }

  // --- battle plans -------------------------------------------------------

  /**
   * Every plan edit needs a selected plan, and every one of these is a no-op
   * without one rather than an error: clicking a plan on the map is the only
   * thing that selects it, and the panel should not be the place that complains
   * about it.
   */
  private selectedPlanId(): number | null {
    return this.game?.selectedBattlePlanId() ?? null;
  }

  private pauseSelectedPlan(): void {
    const planId = this.selectedPlanId();
    if (planId === null) return;
    this.eventBus?.emit(
      new BattlePlanIntentEvent({ type: "pause", planId }),
    );
  }

  private resumeSelectedPlan(): void {
    const planId = this.selectedPlanId();
    if (planId === null) return;
    this.eventBus?.emit(
      new BattlePlanIntentEvent({ type: "resume", planId }),
    );
  }

  private deleteSelectedPlan(): void {
    const planId = this.selectedPlanId();
    if (planId === null) return;
    // Drop the local selection too, so the panel does not keep describing a plan
    // that is already gone until the next update lands.
    this.game?.setSelectedBattlePlan(null);
    this.eventBus?.emit(
      new BattlePlanIntentEvent({ type: "delete", planId }),
    );
  }

  private beginRename(army: ArmyView): void {
    this.nameDraft = army.name();
    this.renameError = null;
    this.editingName = true;
    this.editingComposition = false;
  }

  private onNameKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      this.commitRename(this.game?.selectedArmy() ?? null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.editingName = false;
      this.renameError = null;
    }
  };

  /**
   * Validate locally for immediate feedback, then send. The simulation
   * validates again; this is a courtesy, not the authority.
   */
  private commitRename(army: ArmyView | null): void {
    if (army === null || !this.eventBus) return;
    const result = validateArmyName(this.nameDraft);
    if (!result.ok) {
      this.renameError = this.nameErrorKey(result.reason);
      return;
    }
    this.eventBus.emit(new RenameArmyIntentEvent(army.id, result.name));
    this.editingName = false;
    this.renameError = null;
  }

  /**
   * Rejection reason -> translation key, spelled out rather than interpolated.
   * The translation system checks that every key in en.json is referenced by a
   * literal, so a `army_panel.name_error.${reason}` template would leave four
   * keys looking unused.
   */
  private nameErrorKey(reason: ArmyNameRejection): string {
    switch (reason) {
      case "notAString":
        return "army_panel.name_error.notAString";
      case "onlyStrippedCharacters":
        return "army_panel.name_error.onlyStrippedCharacters";
      case "tooLong":
        return "army_panel.name_error.tooLong";
      default:
        return "army_panel.name_error.empty";
    }
  }

  private beginCompositionEdit(army: ArmyView): void {
    this.compositionDraft = { ...army.composition() };
    this.editingComposition = true;
    this.editingName = false;
  }

  private commitComposition(army: ArmyView): void {
    if (this.compositionDraft === null || !this.eventBus) return;
    this.eventBus.emit(
      new SetArmyCompositionIntentEvent(army.id, this.compositionDraft),
    );
    this.editingComposition = false;
    this.compositionDraft = null;
  }

  // --- presentation helpers ---------------------------------------------

  private supplyColorClass(army: ArmyView): string {
    switch (army.supplyStatus()) {
      case "sufficient":
        return "text-emerald-400";
      case "strained":
        return "text-amber-400";
      case "cut":
        return "text-orange-400";
      default:
        return "text-red-400";
    }
  }

  private categoryColor(category: string): string {
    switch (category) {
      case "infantry":
        return "bg-emerald-500";
      case "armor":
        return "bg-sky-500";
      case "artillery":
        return "bg-orange-500";
      default:
        return "bg-violet-500";
    }
  }

  private orderButtonClass(active: boolean): string {
    const base =
      "rounded px-1 py-1.5 font-medium transition-colors " +
      "bg-white/5 text-zinc-300 hover:bg-white/15";
    return active ? `${base} bg-emerald-600 text-white` : base;
  }

  private orderLabel(army: ArmyView): string {
    const order = army.order();
    switch (order.type) {
      case "move":
        return translateText("army_panel.current_order.move");
      case "attack":
        return translateText("army_panel.current_order.attack");
      case "createFront":
        return translateText("army_panel.current_order.create_front");
      case "reinforce":
        return translateText("army_panel.current_order.reinforce");
      case "stop":
        return translateText("army_panel.current_order.stop");
      default:
        return translateText("army_panel.current_order.hold");
    }
  }
}
