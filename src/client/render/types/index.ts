// Renderer types (units, players, tiles, names, config)
export {
  DEFAULT_NUKE_EXPLOSION_COLOR,
  MAX_NUKE_EXPLOSION_COLORS,
  PlayerTypeEnum,
  TrainType,
} from "./Renderer";
export type {
  AllianceData,
  ArmyState,
  AttackData,
  AttackRingInput,
  ConquestFx,
  DeadUnitFx,
  EmojiData,
  GhostPreviewData,
  NameEntry,
  NukeExplosionRenderParams,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RendererConfig,
  TerrainRect,
  UnitState,
} from "./Renderer";

// Frame data — boundary contract between game integration and features
export type { FrameData } from "./FrameData";

// Army marker instances — the GL-free half of ArmyMarkerPass, so producers do
// not have to import the pass (and its shaders) just to pack a flag word.
export {
  ARMY_MARKER_FLAGS,
  ARMY_MARKER_FLOATS_PER_INSTANCE,
  packArmyMarkerFlags,
} from "./ArmyMarker";
export type { ArmyMarker } from "./ArmyMarker";

// Air wing overlay instances — the GL-free half of AirWingPass (Prompt 7.8).
// Same split as the army marker: producers pack flag words here rather than
// importing the pass and dragging its shaders in.
export {
  AIR_WING_FLAGS,
  AIR_WING_FLOATS_PER_INSTANCE,
  AIR_WING_KIND,
  packAirWingFlags,
} from "./AirWingMarker";
export type {
  AirMissionLine,
  AirRegionOverlay,
  AirWingKind,
  AirWingMarker,
} from "./AirWingMarker";

// Frame events — per-frame ephemeral events (rendering FX)
export type { BonusEvent, FrameEvents } from "./FrameEvents";

// Unit type string constants and derived sets
export {
  ALL_UNIT_TYPES,
  NUKE_MAGNITUDES,
  NUKE_TYPES,
  SMOOTHED_NUKE_TYPES,
  STRUCTURE_TYPES,
  TRAIL_TYPES,
  UT_ATOM_BOMB,
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
} from "./UnitType";
