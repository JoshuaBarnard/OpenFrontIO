import { PlayerBuildableUnitType } from "../core/game/Game";

/**
 * Vassal Estate deliberately reuses UnitType.City in the simulation, but the
 * build HUD still needs a distinct selection value so City and Vassal Estate
 * do not collapse into the same ghost/button state.
 */
export const VASSAL_ESTATE_GHOST = "vassal_estate" as const;

export type GhostStructureType =
  | PlayerBuildableUnitType
  | typeof VASSAL_ESTATE_GHOST;

export interface UIState {
  attackRatio: number;
  ghostStructure: GhostStructureType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
}
