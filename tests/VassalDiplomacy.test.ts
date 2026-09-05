import { AttackExecution } from "../src/core/execution/AttackExecution";
import { ConstructionExecution } from "../src/core/execution/ConstructionExecution";
import { VassalNationExecution } from "../src/core/execution/VassalNationExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import {
  isVassalPlayerID,
  makeVassalDisplayName,
  makeVassalPlayerID,
} from "../src/core/game/Vassal";
import { setup } from "./util/Setup";

describe("Vassal diplomacy and expansion", () => {
  let game: Game;
  let founder: Player;
  let ally: Player;
  let neighbor: Player;

  const founderInfo = new PlayerInfo(
    "Founder",
    PlayerType.Human,
    null,
    "founder",
  );
  const allyInfo = new PlayerInfo("Ally", PlayerType.Human, null, "ally");
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
      [founderInfo, allyInfo, neighborInfo],
    );
    founder = game.player(founderInfo.id);
    ally = game.player(allyInfo.id);
    neighbor = game.player(neighborInfo.id);

    // Keep every diplomacy participant alive outside the Estate radius.
    founder.conquer(game.ref(30, 10));
    ally.conquer(game.ref(31, 10));
    neighbor.conquer(game.ref(32, 10));
  });

  function foundVassal(center = game.ref(0, 10)): Player {
    founder.conquer(center);
    game.addExecution(
      new ConstructionExecution(founder, UnitType.City, center, true),
    );
    game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();

    const vassal = game
      .allPlayers()
      .find((player) => isVassalPlayerID(player.id()));
    expect(vassal).toBeDefined();
    return vassal!;
  }

  function addProtectedTestVassal(): Player {
    const info = new PlayerInfo(
      makeVassalDisplayName(founder.displayName()),
      PlayerType.Nation,
      null,
      makeVassalPlayerID(founder.id(), 998),
    );
    const vassal = game.addPlayer(info);
    vassal.conquer(game.ref(10, 10));

    const request = founder.createAllianceRequest(vassal);
    request?.accept();
    expect(founder.isAlliedWith(vassal)).toBe(true);
    return vassal;
  }

  function addHostileNation(
    id: string,
    name: string,
    x: number,
    y: number,
  ): Player {
    const info = new PlayerInfo(name, PlayerType.Nation, null, id);
    const player = game.addPlayer(info);
    player.conquer(game.ref(x, y));
    return player;
  }

  test("owner ally cannot attack a vassal before alliance mirroring ticks", () => {
    const vassal = foundVassal();

    const request = founder.createAllianceRequest(ally);
    request?.accept();
    expect(founder.isAlliedWith(ally)).toBe(true);

    // Deliberately do not execute another game tick. The explicit vassal
    // alliance has not been mirrored yet, which used to leave a tiny attack
    // window even though the owner and attacker were already allies.
    expect(vassal.isAlliedWith(ally)).toBe(false);

    ally.setTroops(game.config().maxTroops(ally));
    const attack = new AttackExecution(1_000, ally, vassal.id());
    attack.init(game, game.ticks());

    expect(attack.isActive()).toBe(false);
    expect(vassal.incomingAttacks()).toHaveLength(0);
  });

  test("founder receives an alert when a hostile attack starts on its vassal", () => {
    const vassal = foundVassal();
    const invaderInfo = new PlayerInfo(
      "Invader",
      PlayerType.Nation,
      null,
      "invader",
    );
    const invader = game.addPlayer(invaderInfo);
    invader.conquer(game.ref(1, 10));
    invader.setTroops(game.config().maxTroops(invader));

    game.addExecution(new AttackExecution(1_000, invader, vassal.id()));
    const updates = game.executeNextTick();

    const alert = updates[GameUpdateType.DisplayEvent].find(
      (event) => event.message === "vassal.under_attack",
    );
    expect(alert).toBeDefined();
    expect(alert!.playerID).toBe(founder.smallID());
    expect(alert!.focusPlayerID).toBe(invader.smallID());
    expect(alert!.params).toMatchObject({
      vassal: vassal.displayName(),
      name: invader.displayName(),
    });
  });

  test("vassal actively expands into a bordering owner-hostile realm", () => {
    const vassal = addProtectedTestVassal();
    neighbor.conquer(game.ref(11, 10));

    // An owner ally must never be considered a valid expansion target even if
    // the explicit mirrored vassal alliance has not been created yet.
    const request = founder.createAllianceRequest(ally);
    request?.accept();
    expect(founder.isAlliedWith(ally)).toBe(true);
    expect(vassal.isAlliedWith(ally)).toBe(false);

    const maxTroops = game.config().maxTroops(vassal);
    vassal.setTroops(maxTroops);
    neighbor.setTroops(Math.floor(maxTroops / 2));

    const execution = new VassalNationExecution(vassal, founder.id());
    execution.init(game);

    const sendAttack = vi.fn((target: Player) => target === neighbor);
    (execution as any).attackBehavior = { sendAttack };

    expect((execution as any).attackOwnerHostileRealm()).toBe(true);
    expect(sendAttack).toHaveBeenCalled();
    expect(sendAttack.mock.calls[0][0]).toBe(neighbor);
    expect(sendAttack.mock.calls[0][1]).toBe(true);
    expect(sendAttack).not.toHaveBeenCalledWith(ally, expect.anything());
  });

  test("strong local enemy makes vassal build up instead of attacking far away", () => {
    const vassal = addProtectedTestVassal();
    neighbor.conquer(game.ref(11, 10));
    const farEnemy = addHostileNation("far-enemy", "Far Enemy", 28, 20);

    const maxTroops = game.config().maxTroops(vassal);
    vassal.setTroops(Math.floor(maxTroops * 0.6));
    neighbor.setTroops(maxTroops);
    farEnemy.setTroops(1);

    const execution = new VassalNationExecution(vassal, founder.id());
    execution.init(game);

    const sendAttack = vi.fn().mockReturnValue(true);
    (execution as any).attackBehavior = { sendAttack };

    // The weak far enemy would be an easy target, but the bordering threat is
    // strategically more important. The vassal should hold its troops until it
    // is ready for the local fight instead of launching a remote expedition.
    expect((execution as any).attackOwnerHostileRealm()).toBe(true);
    expect(sendAttack).not.toHaveBeenCalled();
  });

  test("after building up vassal attacks local threat before distant enemy", () => {
    const vassal = addProtectedTestVassal();
    neighbor.conquer(game.ref(11, 10));
    const farEnemy = addHostileNation("far-enemy", "Far Enemy", 28, 20);

    const maxTroops = game.config().maxTroops(vassal);
    vassal.setTroops(maxTroops);
    neighbor.setTroops(Math.floor(maxTroops * 0.8));
    farEnemy.setTroops(1);

    const execution = new VassalNationExecution(vassal, founder.id());
    execution.init(game);

    const sendAttack = vi.fn().mockReturnValue(true);
    (execution as any).attackBehavior = { sendAttack };

    expect((execution as any).attackOwnerHostileRealm()).toBe(true);
    expect(sendAttack).toHaveBeenCalledTimes(1);
    expect(sendAttack.mock.calls[0][0]).toBe(neighbor);
    expect(sendAttack.mock.calls[0][1]).toBe(true);
  });

  test("with no local threat vassal considers nearest hostile realm first", () => {
    const vassal = addProtectedTestVassal();
    const fartherEnemy = addHostileNation(
      "farther-enemy",
      "Farther Enemy",
      28,
      20,
    );

    const maxTroops = game.config().maxTroops(vassal);
    vassal.setTroops(maxTroops);
    neighbor.setTroops(1);
    fartherEnemy.setTroops(1);

    const execution = new VassalNationExecution(vassal, founder.id());
    execution.init(game);

    const sendAttack = vi.fn().mockReturnValue(true);
    (execution as any).attackBehavior = { sendAttack };

    expect((execution as any).attackOwnerHostileRealm()).toBe(true);
    expect(sendAttack).toHaveBeenCalledTimes(1);
    // Neighbor owns (32,10), which is closer to the vassal at (10,10) than
    // the extra hostile at (28,20). The old implementation shuffled both.
    expect(sendAttack.mock.calls[0][0]).toBe(neighbor);
  });
});
