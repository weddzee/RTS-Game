/**
 * ArmySelectionController — clicking armies on the map, and the tile-picking
 * half of the army commands (Prompt 3.4, 3.5).
 *
 * Two jobs:
 *
 *  1. Select. A left click on a tile that holds one of the player's own armies
 *     selects it and opens the army panel. Clicking elsewhere clears the
 *     selection — but only once nothing is waiting for a target tile, so a click
 *     meant to place a move does not also deselect.
 *
 *  2. Pick tiles. `Move`, `Draw Offensive` and `Create Front` all name a target
 *     tile for an existing army; raising a new army needs a tile to muster on.
 *     The panel's buttons put this controller into a one-shot pending mode and
 *     the next click resolves it. Re-clicking the same button cancels.
 *
 * It deliberately does not validate anything the simulation cares about — a
 * request it emits may still be refused there, and the panel reflects the
 * result on the next tick like every other action in the game.
 */

import { EventBus } from "../../core/EventBus";
import type { ArmyOrder } from "../../core/game/Army";
import type { ArmyComposition } from "../../core/game/ArmyComposition";
import { Controller } from "../Controller";
import { MouseUpEvent } from "../InputHandler";
import { TransformHandler } from "../TransformHandler";
import { ArmyOrderIntentEvent, CreateArmyIntentEvent } from "../Transport";
import { GameView } from "../view";

/**
 * What the next map click is for. `move`, `attack` and `createFront` name a
 * target tile for an existing army; `create` raises a new army on the clicked
 * tile, which is how the player chooses where their troops muster.
 */
export type PendingArmyOrder = "move" | "attack" | "createFront" | "create";

export interface PendingArmyCreation {
  troops: number;
  name: string | null;
  composition: ArmyComposition;
}

export class ArmySelectionController implements Controller {
  private pending: PendingArmyOrder | null = null;
  /** Carried between `requestCreate` and the click that resolves it. */
  private pendingCreation: PendingArmyCreation | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
  ) {}

  init() {
    this.eventBus.on(MouseUpEvent, (e) => this.onClick(e.x, e.y));
  }

  /** The command waiting for a target tile, or null. Read by the army panel. */
  pendingOrder(): PendingArmyOrder | null {
    return this.pending;
  }

  /**
   * Arm the one-shot tile picker for an existing army. Re-clicking the same
   * button cancels it, so a mis-click is one click to undo.
   */
  requestTile(kind: Exclude<PendingArmyOrder, "create">): void {
    this.pendingCreation = null;
    this.pending = this.pending === kind ? null : kind;
  }

  /**
   * Arm the picker to raise a new army where the player clicks. A creation is
   * not an order on an existing army, so it carries its own payload and is
   * never toggled: asking again replaces it with the latest values.
   */
  requestCreate(creation: PendingArmyCreation): void {
    this.pendingCreation = creation;
    this.pending = "create";
  }

  cancel(): void {
    this.pending = null;
    this.pendingCreation = null;
  }

  private onClick(screenX: number, screenY: number): void {
    const cell = this.transformHandler.screenToWorldCoordinates(
      screenX,
      screenY,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) {
      this.cancel();
      this.game.setSelectedArmy(null);
      return;
    }
    const tile = this.game.ref(cell.x, cell.y);

    const pending = this.pending;
    if (pending !== null) {
      this.pending = null;
      if (pending === "create") {
        this.emitCreation(tile);
        return;
      }
      this.emitOrder(pending, tile);
      return;
    }

    const army = this.game.armyAtTile(tile);
    // Enemies' armies are visible but not selectable: an army panel full of
    // read-only statistics would be noise, and the player's own forces are the
    // ones they can act on.
    this.game.setSelectedArmy(
      army !== undefined && army.isMine(this.game) ? army.id : null,
    );
  }

  private emitCreation(tile: number): void {
    const creation = this.pendingCreation;
    this.pendingCreation = null;
    if (creation === null) return;
    // The simulation refuses a tile outside the owner's territory; the client
    // does not pre-check it, so the form and the rules cannot drift apart.
    this.eventBus.emit(
      new CreateArmyIntentEvent(
        tile,
        creation.troops,
        creation.name,
        creation.composition,
      ),
    );
  }

  private emitOrder(kind: PendingArmyOrder, tile: number): void {
    const army = this.game.selectedArmy();
    if (army === null || !army.isMine(this.game)) return;
    const order: ArmyOrder =
      kind === "move"
        ? { type: "move", tile }
        : kind === "attack"
          ? { type: "attack", tile }
          : { type: "createFront", tile };
    this.eventBus.emit(new ArmyOrderIntentEvent(army.id, order));
  }
}
