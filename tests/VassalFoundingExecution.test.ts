import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { TribeExecution } from "../src/core/execution/TribeExecution";
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

  function addProtectedTestVassal(): Player {
    const vassalInfo = new PlayerInfo(
      "Test Vassal",
      PlayerType.Bot,
      null,
      "test-vassal",
    );
    game.addPlayer(vassalInfo);
    const vassal = game.player(vassalInfo.id);

    founder.conquer(game.ref(5, 10));
    vassal.conquer(game.ref(10, 10));

    const request = founder.createAllianceRequest(vassal);
    request?.accept();
    expect(founder.isAlliedWith(vassal)).toBe(true);

    return vassal;
  }

  function mockFounderAttack(troops: number) {
    return vi.spyOn(founder, "incomingAttacks").mockReturnValue([
      {
        attacker: () => neighbor,
        troops: () => troops,
      } as any,
    ]);
  }

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

  test("vassal retaliation prioritizes the founder's attacker", () => {
    const vassal = addProtectedTestVassal();
    const execution = new TribeExecution(vassal, founder.id());
    execution.init(game);

    const sendAttack = vi.fn().mockReturnValue(true);
    (execution as any).attackBehavior = { sendAttack };
    const incomingSpy = mockFounderAttack(2_000);

    expect((execution as any).defendProtectedPlayer(founder)).toBe(true);
    expect(sendAttack).toHaveBeenCalledWith(neighbor, true);

    incomingSpy.mockRestore();
  });

  test("unreachable vassal can reinforce founder even when normal donations are disabled", () => {
    const vassal = addProtectedTestVassal();
    const execution = new TribeExecution(vassal, founder.id());
    execution.init(game);

    // The test setup leaves donateTroops disabled. Founder defense is a vassal
    // mechanic, so it deliberately uses the low-level transfer instead of the
    // optional manual-donation action.
    expect(game.config().gameConfig().donateTroops).toBe(false);

    const maxVassalTroops = game.config().maxTroops(vassal);
    const maxFounderTroops = game.config().maxTroops(founder);
    vassal.setTroops(maxVassalTroops);
    founder.setTroops(Math.floor(maxFounderTroops / 2));

    const sendAttack = vi.fn().mockReturnValue(false);
    (execution as any).attackBehavior = { sendAttack };
    const incomingSpy = mockFounderAttack(1_000);
    const donateSpy = vi.spyOn(vassal, "donateTroops");

    expect((execution as any).defendProtectedPlayer(founder)).toBe(true);
    expect(sendAttack).toHaveBeenCalledWith(neighbor, true);
    expect(donateSpy).toHaveBeenCalledWith(
      founder,
      expect.any(Number),
    );
    expect(donateSpy.mock.calls[0][1]).toBeGreaterThan(0);

    donateSpy.mockRestore();
    incomingSpy.mockRestore();
  });

  test("vassal keeps enough troops to match its strongest hostile border", () => {
    const vassal = addProtectedTestVassal();

    // Move the hostile neighbor onto a direct border with the vassal.
    neighbor.conquer(game.ref(11, 10));
    const maxVassalTroops = game.config().maxTroops(vassal);
    vassal.setTroops(maxVassalTroops);
    neighbor.setTroops(maxVassalTroops);
    founder.setTroops(Math.floor(game.config().maxTroops(founder) / 2));

    const execution = new TribeExecution(vassal, founder.id());
    execution.init(game);
    const sendAttack = vi.fn().mockReturnValue(false);
    (execution as any).attackBehavior = { sendAttack };
    const incomingSpy = mockFounderAttack(1_000);
    const donateSpy = vi.spyOn(vassal, "donateTroops");

    expect((execution as any).defendProtectedPlayer(founder)).toBe(true);
    expect(donateSpy).not.toHaveBeenCalled();

    donateSpy.mockRestore();
    incomingSpy.mockRestore();
  });
});
