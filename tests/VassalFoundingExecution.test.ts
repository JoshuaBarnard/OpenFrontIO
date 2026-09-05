import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { VassalNationExecution } from "../src/core/execution/VassalNationExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import {
  isVassalPlayerID,
  makeVassalDisplayName,
  makeVassalPlayerID,
  vassalOwnerIDFromPlayerID,
} from "../src/core/game/Vassal";
import { setup } from "./util/Setup";

describe("Vassal Estate", () => {
  let game: Game;
  let founder: Player;
  let neighbor: Player;
  let ally: Player;

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
  const allyInfo = new PlayerInfo("Ally", PlayerType.Human, null, "ally");

  beforeEach(async () => {
    game = await setup(
      "plains",
      { infiniteGold: true, infiniteTroops: true, instantBuild: true },
      [founderInfo, neighborInfo, allyInfo],
    );
    founder = game.player(founderInfo.id);
    neighbor = game.player(neighborInfo.id);
    ally = game.player(allyInfo.id);

    // Diplomacy APIs intentionally reject eliminated players. Keep all three
    // human fixtures alive on territory outside the Estate's radius so these
    // tests model a real in-game founder, ally and neighbor. In particular,
    // the Estate must not transfer the founder's final tile and silently make
    // subsequent alliance tests operate on a dead player.
    founder.conquer(game.ref(30, 10));
    neighbor.conquer(game.ref(31, 10));
    ally.conquer(game.ref(32, 10));
  });

  function foundVassal(center = game.ref(0, 10)): Player {
    founder.conquer(center);
    game.addExecution(
      new ConstructionExecution(founder, UnitType.City, center, true),
    );
    game.executeNextTick(); // initialize construction
    game.executeNextTick(); // instant-build city, queue founding
    game.executeNextTick(); // found vassal

    const vassal = game
      .allPlayers()
      .find((player) => isVassalPlayerID(player.id()));
    expect(vassal).toBeDefined();
    return vassal!;
  }

  function addProtectedTestVassal(): Player {
    const vassalInfo = new PlayerInfo(
      makeVassalDisplayName(founder.displayName()),
      PlayerType.Nation,
      null,
      makeVassalPlayerID(founder.id(), 999),
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
    const attack = {
      attacker: () => neighbor,
      troops: () => troops,
    } as ReturnType<Player["incomingAttacks"]>[number];
    return vi.spyOn(founder, "incomingAttacks").mockReturnValue([attack]);
  }

  test("completed estate creates a nation vassal from founder-owned territory", () => {
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

    game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();

    const vassal = game
      .allPlayers()
      .find((player) => isVassalPlayerID(player.id()));

    expect(vassal).toBeDefined();
    expect(vassal!.type()).toBe(PlayerType.Nation);
    expect(vassal!.displayName()).toBe("Founder's Vassal");
    expect(vassalOwnerIDFromPlayerID(vassal!.id())).toBe(founder.id());
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

    const executions = (
      game as unknown as { executions(): unknown[] }
    ).executions();
    expect(
      executions.some((execution) => execution instanceof VassalNationExecution),
    ).toBe(true);
  });

  test("founder-vassal alliance is restored after a manual break", () => {
    const vassal = foundVassal();
    const alliance = founder.allianceWith(vassal);
    expect(alliance).not.toBeNull();

    founder.breakAlliance(alliance!);
    expect(founder.isAlliedWith(vassal)).toBe(false);

    game.executeNextTick();

    expect(founder.isAlliedWith(vassal)).toBe(true);
    expect(vassal.isAlliedWith(founder)).toBe(true);
  });

  test("vassal alliances mirror the founder's alliances", () => {
    const vassal = foundVassal();

    const founderAllyRequest = founder.createAllianceRequest(ally);
    founderAllyRequest?.accept();
    expect(founder.isAlliedWith(ally)).toBe(true);

    game.executeNextTick();
    expect(vassal.isAlliedWith(ally)).toBe(true);

    founder.allianceWith(ally)!.expire();
    expect(founder.isAlliedWith(ally)).toBe(false);

    game.executeNextTick();
    expect(vassal.isAlliedWith(ally)).toBe(false);
  });

  test("alliance requests aimed at a vassal are redirected to its founder", () => {
    const vassal = foundVassal();

    game.addExecution(new AllianceRequestExecution(neighbor, vassal.id()));
    game.executeNextTick();

    expect(
      neighbor
        .outgoingAllianceRequests()
        .some((request) => request.recipient() === founder),
    ).toBe(true);
    expect(
      neighbor
        .outgoingAllianceRequests()
        .some((request) => request.recipient() === vassal),
    ).toBe(false);
  });

  test("vassals cannot originate alliance requests", () => {
    const vassal = foundVassal();

    game.addExecution(new AllianceRequestExecution(vassal, neighbor.id()));
    game.executeNextTick();

    expect(
      vassal
        .outgoingAllianceRequests()
        .some((request) => request.recipient() === neighbor),
    ).toBe(false);
  });

  test("ordinary cities do not found vassals", () => {
    const center = game.ref(0, 10);
    founder.conquer(center);

    game.addExecution(new ConstructionExecution(founder, UnitType.City, center));
    game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();

    expect(
      game.allPlayers().filter((player) => isVassalPlayerID(player.id())),
    ).toHaveLength(0);
    expect(game.owner(center)).toBe(founder);
    expect(founder.units(UnitType.City)).toHaveLength(1);
  });

  test("vassal retaliation prioritizes the founder's attacker", () => {
    const vassal = addProtectedTestVassal();
    const execution = new VassalNationExecution(vassal, founder.id());
    execution.init(game);

    const sendAttack = vi.fn().mockReturnValue(true);
    (execution as any).attackBehavior = { sendAttack };
    const incomingSpy = mockFounderAttack(2_000);

    expect((execution as any).defendFounder()).toBe(true);
    expect(sendAttack).toHaveBeenCalledWith(neighbor, true);

    incomingSpy.mockRestore();
  });

  test("unreachable vassal can reinforce founder even when normal donations are disabled", () => {
    const vassal = addProtectedTestVassal();
    const execution = new VassalNationExecution(vassal, founder.id());
    execution.init(game);

    // The test setup leaves donateTroops disabled. Founder defense is a vassal
    // obligation, so it deliberately uses the low-level transfer instead of
    // the optional manual-donation action.
    expect(game.config().gameConfig().donateTroops).toBe(false);

    const maxVassalTroops = game.config().maxTroops(vassal);
    const maxFounderTroops = game.config().maxTroops(founder);
    vassal.setTroops(maxVassalTroops);
    founder.setTroops(Math.floor(maxFounderTroops / 2));

    const sendAttack = vi.fn().mockReturnValue(false);
    (execution as any).attackBehavior = { sendAttack };
    const incomingSpy = mockFounderAttack(1_000);
    const donateSpy = vi.spyOn(vassal, "donateTroops");

    expect((execution as any).defendFounder()).toBe(true);
    expect(sendAttack).toHaveBeenCalledWith(neighbor, true);
    expect(donateSpy).toHaveBeenCalledWith(founder, expect.any(Number));
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

    const execution = new VassalNationExecution(vassal, founder.id());
    execution.init(game);
    const sendAttack = vi.fn().mockReturnValue(false);
    (execution as any).attackBehavior = { sendAttack };
    const incomingSpy = mockFounderAttack(1_000);
    const donateSpy = vi.spyOn(vassal, "donateTroops");

    expect((execution as any).defendFounder()).toBe(true);
    expect(donateSpy).not.toHaveBeenCalled();

    donateSpy.mockRestore();
    incomingSpy.mockRestore();
  });
});
