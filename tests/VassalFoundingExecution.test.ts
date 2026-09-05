import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

describe("Vassal Estate", () => {
  let game: Game;
  let founder: Player;
  let neighbor: Player;

  const founderInfo = new PlayerInfo(
    "Founder",
    PlayerType.Human,
    null,
    "founder",
  );
  const neighborInfo = new PlayerInfo(
    "Neighbor",
    PlayerType.Human,
    null,
    "neighbor",
  );

  beforeEach(async () => {
    game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [founderInfo, neighborInfo],
    );
    founder = game.player(founderInfo.id);
    neighbor = game.player(neighborInfo.id);
  });

  test("completed estate creates an allied bot from founder-owned territory", () => {
    const center = game.ref(0, 10);
    const nearby = game.ref(1, 10);
    const neighborTile = game.ref(2, 10);
    const farAway = game.ref(30, 10);

    founder.conquer(center);
    founder.conquer(nearby);
    founder.conquer(farAway);
    neighbor.conquer(neighborTile);

    game.addExecution(
      // The optional City build flag marks this as a Vassal Estate.
      new ConstructionExecution(founder, UnitType.City, center, true),
    );

    game.executeNextTick(); // initialize construction
    game.executeNextTick(); // instant-build city, queue founding
    game.executeNextTick(); // found vassal

    const vassal = game
      .allPlayers()
      .find((player) => player.type() === PlayerType.Bot);

    expect(vassal).toBeDefined();
    expect(vassal!.id()).toMatch(/^vassal-founder-/);
    expect(vassal!.hasSpawned()).toBe(true);
    expect(vassal!.spawnTile()).toBe(center);

    expect(game.owner(center)).toBe(vassal);
    expect(game.owner(nearby)).toBe(vassal);
    expect(game.owner(neighborTile)).toBe(neighbor);
    expect(game.owner(farAway)).toBe(founder);

    const capital = vassal!.units(UnitType.City)[0];
    expect(capital).toBeDefined();
    expect(capital.owner()).toBe(vassal);
    expect(capital.tile()).toBe(center);

    expect(founder.isAlliedWith(vassal!)).toBe(true);
    expect(vassal!.isAlliedWith(founder)).toBe(true);
  });

  test("founder-vassal alliance is restored after a manual break", () => {
    const center = game.ref(0, 10);
    founder.conquer(center);

    game.addExecution(
      new ConstructionExecution(founder, UnitType.City, center, true),
    );
    game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();

    const vassal = game
      .allPlayers()
      .find((player) => player.type() === PlayerType.Bot)!;
    const alliance = founder.allianceWith(vassal);
    expect(alliance).not.toBeNull();

    founder.breakAlliance(alliance!);
    expect(founder.isAlliedWith(vassal)).toBe(false);

    game.executeNextTick();

    expect(founder.isAlliedWith(vassal)).toBe(true);
    expect(vassal.isAlliedWith(founder)).toBe(true);
  });

  test("ordinary cities do not found vassals", () => {
    const center = game.ref(0, 10);
    founder.conquer(center);

    game.addExecution(new ConstructionExecution(founder, UnitType.City, center));
    game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();

    expect(
      game.allPlayers().filter((player) => player.type() === PlayerType.Bot),
    ).toHaveLength(0);
    expect(game.owner(center)).toBe(founder);
    expect(founder.units(UnitType.City)).toHaveLength(1);
  });
});
