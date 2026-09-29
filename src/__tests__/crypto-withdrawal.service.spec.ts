import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { CryptoWithdrawalService } from "../payment/crypto-withdrawal.service";
import { KycStatus } from "../entities/user.entity";
import {
  WithdrawalApprovalStatus,
  WithdrawalDestinationStatus,
} from "../entities/crypto-withdrawal.entity";
import { TransactionType } from "../entities/transaction.entity";

const USDT_USER = { id: "u1", currency: "USDT", kycStatus: KycStatus.APPROVED };
const ACTIVE_DEST = {
  id: "d1",
  userId: "u1",
  pay21DestinationId: "p21-d1",
  network: "tron",
  address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  status: WithdrawalDestinationStatus.ACTIVE,
  usableAt: null,
};

function build(opts: {
  user?: any;
  destination?: any;
  withdrawal?: any;
  balance?: string;
  // Simulate losing a cross-replica race: the conditional claim matches 0 rows.
  restoreClaimAffected?: number;
  completedClaimAffected?: number;
  /** Config overrides. The tests below this file's HD section exercise the
   *  original `destination` flow, so that is the default here. */
  config?: Record<string, string>;
  /** Affected rows for the approve() claim (pending → approved). */
  approveClaimAffected?: number;
  /** Affected rows for the reject() claim, inside the refund transaction. */
  rejectClaimAffected?: number;
  /** Per-query lookup for withdrawalRepo.findOneBy; defaults to `withdrawal`. */
  findWithdrawal?: (where: any) => any;
} = {}) {
  const saved: { entity: string; value: any }[] = [];
  const updates: { entity: string; where: any; patch: any }[] = [];
  const notifications: any[] = [];

  const mkQb = () => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ balance: opts.balance ?? "100" }),
  });

  const em: any = {
    getRepository: jest.fn().mockReturnValue({ createQueryBuilder: mkQb }),
    create: jest.fn().mockImplementation((_e: any, d: any) => ({ ...d })),
    save: jest.fn().mockImplementation((entity: any, d: any) => {
      const name = entity?.name ?? "unknown";
      const row = { id: `${name}-1`, ...d };
      saved.push({ entity: name, value: row });
      return Promise.resolve(row);
    }),
    update: jest.fn().mockImplementation((e: any, where: any, patch: any) => {
      updates.push({ entity: e?.name, where, patch });
      // The restore() refund claim is conditional on restoreTransactionId IS
      // NULL; let a test force it to match 0 rows (another replica won).
      const affected =
        patch?.restoreTransactionId !== undefined
          ? opts.restoreClaimAffected ?? 1
          : patch?.approvalStatus === WithdrawalApprovalStatus.REJECTED
            ? opts.rejectClaimAffected ?? 1
            : 1;
      return Promise.resolve({ affected });
    }),
  };

  const withdrawalRepo: any = {
    findOneBy: jest.fn().mockImplementation(async (where: any) =>
      opts.findWithdrawal ? opts.findWithdrawal(where) : (opts.withdrawal ?? null),
    ),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((d: any) => ({ id: "w1", ...d })),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
    update: jest.fn().mockImplementation((where: any, patch: any) => {
      updates.push({ entity: "CryptoWithdrawal", where, patch });
      // The COMPLETED transition claim is conditional on completedAt IS NULL;
      // let a test force it to match 0 rows (another replica already completed).
      const affected =
        patch?.completedAt !== undefined
          ? opts.completedClaimAffected ?? 1
          : where?.approvalStatus === WithdrawalApprovalStatus.PENDING_APPROVAL &&
              patch?.approvalStatus === WithdrawalApprovalStatus.APPROVED
            ? opts.approveClaimAffected ?? 1
            : 1;
      return Promise.resolve({ affected });
    }),
  };
  const destRepo: any = {
    findOneBy: jest.fn().mockResolvedValue(
      opts.destination === undefined ? ACTIVE_DEST : opts.destination,
    ),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((d: any) => ({ id: "d1", ...d })),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const userRepo: any = {
    findOneBy: jest
      .fn()
      .mockResolvedValue(opts.user === undefined ? USDT_USER : opts.user),
  };
  const ds: any = { transaction: (cb: Function) => cb(em) };
  const client: any = {
    enabled: true,
    isNetworkEnabled: jest.fn().mockReturnValue(true),
    createWithdrawalDestination: jest
      .fn()
      .mockResolvedValue({ id: "p21-d1", status: "cooldown" }),
    createWithdrawal: jest
      .fn()
      .mockResolvedValue({ id: "p21-w1", status: "approved" }),
    createCustomerPayout: jest
      .fn()
      .mockResolvedValue({ id: "p21-cp1", status: "approved" }),
    getWithdrawal: jest.fn(),
  };
  const cfg: Record<string, string> = {
    USDT_PAYOUT_MODE: "destination",
    ...opts.config,
  };
  const config: any = { get: (k: string, d?: string) => cfg[k] ?? d };

  const userNotifRepo = {
    create: (e: any) => e,
    save: async (n: any) => {
      notifications.push(n);
      return n;
    },
  };
  const redis = { del: jest.fn(async (..._k: string[]) => undefined) };
  const sse = { emit: jest.fn() };
  const service = new CryptoWithdrawalService(
    withdrawalRepo,
    destRepo,
    userRepo,
    ds,
    client,
    config,
    userNotifRepo as any,
    redis as any,
    sse as any,
  );
  return {
    service,
    redis,
    sse,
    saved,
    updates,
    notifications,
    client,
    withdrawalRepo,
    destRepo,
  };
}

describe("addDestination", () => {
  it("validates the address locally before 21Pay ever sees it", async () => {
    // A wrong-network send is unrecoverable, and their error message is a
    // worse place to find out than our own validation.
    const { service, client } = build({ destination: null });
    await expect(
      service.addDestination("u1", { network: "tron", address: "0xdeadbeef" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.createWithdrawalDestination).not.toHaveBeenCalled();
  });

  it("stores a new destination in cooldown", async () => {
    const { service } = build({ destination: null });
    const dest = await service.addDestination("u1", {
      network: "tron",
      address: ACTIVE_DEST.address,
    });
    expect(dest.status).toBe(WithdrawalDestinationStatus.COOLDOWN);
    expect(dest.pay21DestinationId).toBe("p21-d1");
  });

  it("refuses an account that cannot hold USDT", async () => {
    const { service } = build({
      user: {
        ...USDT_USER,
        currency: "BTN",
        kycStatus: KycStatus.NONE,
        dkAccountNumber: null,
      },
    });
    await expect(
      service.addDestination("u1", {
        network: "tron",
        address: ACTIVE_DEST.address,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets a Bhutanese account withdraw USDT it deposited", async () => {
    // Money that can go in and never come out is the worse failure. If a BTN
    // account was allowed to deposit, it must be allowed to take it back.
    const { service } = build({
      user: {
        ...USDT_USER,
        currency: "BTN",
        kycStatus: KycStatus.APPROVED,
      },
    });
    await expect(
      service.addDestination("u1", {
        network: "tron",
        address: ACTIVE_DEST.address,
      }),
    ).resolves.toBeDefined();
  });
});

describe("request", () => {
  it("debits immediately so the same balance cannot be requested twice", async () => {
    const { service, saved } = build();
    await service.request("u1", {
      destinationId: "d1",
      amountUsdt: "10",
      clientRequestId: "r1",
    });

    const debit = saved.find((r) => r.entity === "Transaction")!.value;
    expect(Number(debit.amount)).toBe(-10);
    expect(debit.currency).toBe("USDT");
    expect(debit.type).toBe(TransactionType.WITHDRAWAL);
  });

  it("refreshes the wallet balance after the debit", async () => {
    const { service, redis, sse } = build();
    await service.request("u1", {
      destinationId: "d1",
      amountUsdt: "10",
      clientRequestId: "r1",
    });
    expect(redis.del).toHaveBeenCalledWith("oro:cache:balance:u1");
    expect(sse.emit).toHaveBeenCalledWith(
      "u1",
      "balance:updated",
      expect.objectContaining({ currency: "USDT" }),
    );
  });

  it("explains the 24h cooldown rather than refusing blankly", async () => {
    // A winner who cannot be paid for 24 hours needs to know why, or the
    // product looks broken at exactly the moment it matters most.
    const usableAt = new Date(Date.now() + 20 * 3_600_000);
    const { service } = build({
      destination: {
        ...ACTIVE_DEST,
        status: WithdrawalDestinationStatus.COOLDOWN,
        usableAt,
      },
    });
    await expect(
      service.request("u1", {
        destinationId: "d1",
        amountUsdt: "10",
        clientRequestId: "r1",
      }),
    ).rejects.toThrow(/held for 24 hours/);
  });

  it("refuses more than the balance", async () => {
    const { service, saved } = build({ balance: "5" });
    await expect(
      service.request("u1", {
        destinationId: "d1",
        amountUsdt: "10",
        clientRequestId: "r1",
      }),
    ).rejects.toThrow(/Insufficient balance/);
    expect(saved).toHaveLength(0);
  });

  it("refuses someone else's destination", async () => {
    const { service } = build({
      destination: { ...ACTIVE_DEST, userId: "someone-else" },
    });
    await expect(
      service.request("u1", {
        destinationId: "d1",
        amountUsdt: "10",
        clientRequestId: "r1",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("approve and reject", () => {
  const pending = {
    id: "w1",
    userId: "u1",
    destinationId: "d1",
    // The chain is carried on the withdrawal itself; 21Pay requires it on the
    // submission and a fixture without it hid that.
    network: "tron",
    amountUsdt: 10,
    approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL,
    idempotencyKey: "wd:u1:r1",
    restoreTransactionId: null,
  };

  it("submits to 21Pay on approval", async () => {
    const { service, client, updates } = build({ withdrawal: pending });
    await service.approve("admin-1", "w1");

    // `network` and `requestedBy` are required by the engine and documented
    // nowhere; omitting them failed with a bare 500 at approval time, after
    // the user had already been debited.
    expect(client.createWithdrawal).toHaveBeenCalledWith({
      idempotencyKey: "wd:u1:r1",
      destinationId: "p21-d1",
      amountBaseUnits: "10000000",
      network: "tron",
      // The requester, never the approving admin — 21Pay runs its own
      // maker-checker and naming the approver would defeat it.
      requestedBy: "u1",
    });
    // Claimed first, then the payout id is stored once 21 Pay accepts.
    const patches = updates
      .filter((u) => u.entity === "CryptoWithdrawal")
      .map((u) => u.patch);
    expect(patches[0].approvalStatus).toBe(WithdrawalApprovalStatus.APPROVED);
    expect(patches.some((p) => p.pay21WithdrawalId === "p21-w1")).toBe(true);
  });

  it("will not let someone approve their own withdrawal", async () => {
    // 21Pay enforces maker-checker on their side; a user who is also an admin
    // must not be able to release their own money on ours.
    const { service, client } = build({ withdrawal: pending });
    await expect(service.approve("u1", "w1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(client.createWithdrawal).not.toHaveBeenCalled();
  });

  it("returns the money on rejection", async () => {
    const { service, saved } = build({ withdrawal: pending });
    await service.reject("admin-1", "w1", "Suspicious pattern");

    const credit = saved.find((r) => r.entity === "Transaction")!.value;
    expect(Number(credit.amount)).toBe(10);
    expect(credit.currency).toBe("USDT");
  });

  it("refreshes the wallet balance after returning the money", async () => {
    const { service, redis, sse } = build({ withdrawal: pending });
    await service.reject("admin-1", "w1", "Suspicious pattern");
    expect(redis.del).toHaveBeenCalledWith(expect.stringMatching(/^oro:cache:balance:/));
    expect(sse.emit).toHaveBeenCalledWith(
      expect.any(String),
      "balance:updated",
      expect.objectContaining({ currency: "USDT" }),
    );
  });

  it("refuses a second decision", async () => {
    const { service } = build({
      withdrawal: { ...pending, approvalStatus: WithdrawalApprovalStatus.APPROVED },
    });
    await expect(service.approve("admin-1", "w1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe("applyRemoteState — only `completed` means paid", () => {
  const submitted = {
    id: "w1",
    userId: "u1",
    amountUsdt: 10,
    remoteStatus: "approved",
    txHash: null,
    restoreTransactionId: null,
  };

  it("marks completed and does not touch the balance", async () => {
    const { service, saved, updates } = build({ withdrawal: submitted });
    await service.applyRemoteState("w1", {
      status: "completed",
      tx_hash: "0xabc",
    });
    expect(updates[updates.length - 1].patch.completedAt).toBeInstanceOf(Date);
    expect(saved.filter((r) => r.entity === "Transaction")).toHaveLength(0);
  });

  it("does NOT treat broadcast or confirming as paid", async () => {
    for (const status of ["broadcasting", "confirming"]) {
      const { service, updates } = build({ withdrawal: submitted });
      await service.applyRemoteState("w1", { status });
      const patch = updates[updates.length - 1].patch;
      expect({ status, completed: patch.completedAt }).toEqual({
        status,
        completed: undefined,
      });
    }
  });

  it("restores on failure when no tx hash was ever set", async () => {
    // Never broadcast, or mined and reverted. Nothing moved.
    const { service, saved } = build({ withdrawal: submitted });
    await service.applyRemoteState("w1", {
      status: "failed",
      failure_reason: "insufficient gas",
    });
    const credit = saved.find((r) => r.entity === "Transaction")!.value;
    expect(Number(credit.amount)).toBe(10);
  });

  it("does NOT restore on failure when a tx hash exists", async () => {
    // The dangerous case. A broadcast happened and may have landed; 21Pay's
    // own reaper refuses to auto-reverse these. Restoring blind pays the user
    // twice — once on chain, once back into their balance.
    const { service, saved, updates } = build({ withdrawal: submitted });
    await service.applyRemoteState("w1", {
      status: "failed",
      tx_hash: "0xmaybe-landed",
      failure_reason: "broadcast uncertain",
    });

    expect(saved.filter((r) => r.entity === "Transaction")).toHaveLength(0);
    expect(updates[updates.length - 1].patch.needsManualReview).toBe(true);
  });

  it("ignores an update for an already-terminal withdrawal", async () => {
    const { service, saved } = build({
      withdrawal: { ...submitted, remoteStatus: "completed" },
    });
    await service.applyRemoteState("w1", { status: "failed" });
    expect(saved).toHaveLength(0);
  });

  it("does not restore twice", async () => {
    const { service, saved } = build({
      withdrawal: { ...submitted, restoreTransactionId: "already" },
    });
    await service.applyRemoteState("w1", { status: "failed" });
    expect(saved.filter((r) => r.entity === "Transaction")).toHaveLength(0);
  });

  // Every replica polls the same withdrawals, so terminal handling must be
  // exactly-once across replicas — one refund, one notification.
  it("notifies 'sent' once, and not at all if another replica already completed it", async () => {
    const won = build({ withdrawal: submitted });
    await won.service.applyRemoteState("w1", { status: "completed" });
    expect(won.notifications).toHaveLength(1);
    expect(won.notifications[0].title).toBe("Withdrawal sent");

    // completedAt-claim matches 0 rows → another replica won → we stay silent.
    const lost = build({ withdrawal: submitted, completedClaimAffected: 0 });
    await lost.service.applyRemoteState("w1", { status: "completed" });
    expect(lost.notifications).toHaveLength(0);
  });

  it("refunds and notifies exactly once; a replica that loses the claim does neither", async () => {
    const won = build({ withdrawal: submitted });
    await won.service.applyRemoteState("w1", {
      status: "failed",
      failure_reason: "insufficient gas",
    });
    expect(
      won.notifications.filter((n) => n.title === "Withdrawal refunded"),
    ).toHaveLength(1);

    // restoreTransactionId-claim matches 0 rows → the refund insert rolls back
    // and no duplicate "refunded" notification is sent.
    const lost = build({ withdrawal: submitted, restoreClaimAffected: 0 });
    await lost.service.applyRemoteState("w1", {
      status: "failed",
      failure_reason: "insufficient gas",
    });
    expect(
      lost.notifications.filter((n) => n.title === "Withdrawal refunded"),
    ).toHaveLength(0);
  });
});

describe("destination cooldown", () => {
  it("stores the cooldown 21Pay actually returns", async () => {
    // The live API returns `active_at`; their integration page documents
    // `usable_at`. Reading only the documented name stored null, so a
    // destination still in cooldown looked ready in Oro and the rejection
    // surfaced only when an admin tried to approve the payout.
    const { service, destRepo, client } = build({
      user: USDT_USER,
      destination: null,
    });
    client.createWithdrawalDestination = jest.fn().mockResolvedValue({
      id: "remote-1",
      network: "tron",
      address: ACTIVE_DEST.address,
      status: "active",
      active_at: "2026-08-21T09:49:14Z",
    });

    await service.addDestination("u1", {
      network: "tron",
      address: ACTIVE_DEST.address,
    });

    const row = (destRepo.save as jest.Mock).mock.calls[0][0];
    expect(row.usableAt).toEqual(new Date("2026-08-21T09:49:14Z"));
  });

  it("still honours the documented field if they ever send it", async () => {
    const { service, destRepo, client } = build({
      user: USDT_USER,
      destination: null,
    });
    client.createWithdrawalDestination = jest.fn().mockResolvedValue({
      id: "remote-2",
      network: "tron",
      address: ACTIVE_DEST.address,
      status: "active",
      usable_at: "2026-08-22T00:00:00Z",
    });

    await service.addDestination("u1", {
      network: "tron",
      address: ACTIVE_DEST.address,
    });

    const row = (destRepo.save as jest.Mock).mock.calls[0][0];
    expect(row.usableAt).toEqual(new Date("2026-08-22T00:00:00Z"));
  });
});

describe("cooldown blocks approval", () => {
  const pendingWd = {
    id: "w1",
    userId: "u1",
    destinationId: "d1",
    network: "tron",
    amountUsdt: 10,
    approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL,
    idempotencyKey: "wd:u1:r1",
    restoreTransactionId: null,
  };

  it("refuses before calling 21Pay when the destination is in cooldown", async () => {
    // Their engine would refuse anyway, but the admin UI is not the authority
    // and a pointless call to the money API on every premature click is worth
    // avoiding.
    const { service, client } = build({
      withdrawal: pendingWd,
      destination: {
        ...ACTIVE_DEST,
        usableAt: new Date(Date.now() + 3_600_000),
      },
    });

    await expect(service.approve("admin-1", "w1")).rejects.toThrow(/cooldown/i);
    expect(client.createWithdrawal).not.toHaveBeenCalled();
  });

  it("submits once the cooldown has passed", async () => {
    const { service, client } = build({
      withdrawal: pendingWd,
      destination: {
        ...ACTIVE_DEST,
        usableAt: new Date(Date.now() - 1_000),
      },
    });

    await service.approve("admin-1", "w1");
    expect(client.createWithdrawal).toHaveBeenCalled();
  });

  it("leaves the withdrawal approvable rather than consuming it", async () => {
    // The debit stays either way; what must not happen is the request being
    // marked approved with nothing sent, which would strand the money.
    const { service, updates } = build({
      withdrawal: pendingWd,
      destination: {
        ...ACTIVE_DEST,
        usableAt: new Date(Date.now() + 3_600_000),
      },
    });

    await expect(service.approve("admin-1", "w1")).rejects.toThrow();
    expect(
      updates.some((u) => u.patch?.approvalStatus === WithdrawalApprovalStatus.APPROVED),
    ).toBe(false);
  });
});

// ── Single HD wallet: customer payouts ─────────────────────────────────────
//
// 21PAY-HD-WALLET-CONTRACT.md §3. The default payout mode; the tests above
// pin `destination` to keep exercising the original flow.

const HD = { USDT_PAYOUT_MODE: "customer_payout" };
const HD_DEST = {
  id: "d1",
  userId: "u1",
  pay21DestinationId: null,
  network: "tron",
  address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  status: WithdrawalDestinationStatus.ACTIVE,
  usableAt: new Date(Date.now() - 60_000),
};
const hdPending = () => ({
  id: "w1",
  userId: "u1",
  destinationId: "d1",
  network: "tron",
  amountUsdt: "10.000000000",
  approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL,
  idempotencyKey: "wd:u1:r1",
  pay21WithdrawalId: null,
  remoteStatus: null,
  restoreTransactionId: null,
  txHash: null,
});
const refunds = (saved: { entity: string; value: any }[]) =>
  saved.filter(
    (r) => r.entity === "Transaction" && r.value.type === TransactionType.REFUND,
  );
const upstream = (status: number) =>
  Object.assign(new Error(`Twenty-one Pay POST failed with ${status}`), {
    upstreamStatus: status,
  });

describe("HD: payout addresses", () => {
  it("never registers with 21 Pay, and starts our own 24h cooldown", async () => {
    const { service, client, destRepo } = build({ config: HD });
    destRepo.findOneBy.mockResolvedValue(null);
    const before = Date.now();
    const d: any = await service.addDestination("u1", {
      network: "tron",
      address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    });
    expect(client.createWithdrawalDestination).not.toHaveBeenCalled();
    expect(d.status).toBe(WithdrawalDestinationStatus.COOLDOWN);
    expect(d.pay21DestinationId).toBeNull();
    const waitH = (d.usableAt.getTime() - before) / 3_600_000;
    expect(waitH).toBeGreaterThanOrEqual(23.99);
    expect(waitH).toBeLessThanOrEqual(24.01);
  });

  it("refuses a chain customer payouts do not cover", async () => {
    const { service, destRepo } = build({ config: HD });
    destRepo.findOneBy.mockResolvedValue(null);
    await expect(
      service.addDestination("u1", {
        network: "ethereum",
        address: "0x52908400098527886E0F7030069857D2E4169EE7",
      }),
    ).rejects.toThrow(/only Tron/);
  });

  it("ends a cooldown once its time has passed", async () => {
    const { service, destRepo } = build({ config: HD });
    await service.listDestinations("u1");
    expect(destRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        status: WithdrawalDestinationStatus.COOLDOWN,
      }),
      { status: WithdrawalDestinationStatus.ACTIVE },
    );
  });

  it("lets a withdrawal be requested once the cooldown has passed", async () => {
    const { service } = build({
      config: HD,
      destination: {
        ...HD_DEST,
        status: WithdrawalDestinationStatus.COOLDOWN,
        usableAt: new Date(Date.now() - 1_000),
      },
    });
    await expect(
      service.request("u1", { destinationId: "d1", amountUsdt: "10", clientRequestId: "r1" }),
    ).resolves.toBeDefined();
  });

  it("refuses a request while the cooldown is running", async () => {
    const { service } = build({
      config: HD,
      destination: {
        ...HD_DEST,
        status: WithdrawalDestinationStatus.COOLDOWN,
        usableAt: new Date(Date.now() + 3_600_000),
      },
    });
    await expect(
      service.request("u1", { destinationId: "d1", amountUsdt: "10", clientRequestId: "r1" }),
    ).rejects.toThrow(/held for 24 hours/);
  });
});

describe("HD: approve", () => {
  it("sends a customer payout with our key, the user, the address and micro-USDT", async () => {
    const { service, client, updates } = build({
      config: HD,
      withdrawal: hdPending(),
      destination: HD_DEST,
    });
    await service.approve("admin-1", "w1");

    expect(client.createCustomerPayout).toHaveBeenCalledWith({
      idempotencyKey: "wd:u1:r1",
      endUserId: "u1",
      network: "tron",
      toAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      amountBaseUnits: "10000000",
    });
    expect(client.createWithdrawal).not.toHaveBeenCalled();

    const patches = updates.filter((u) => u.entity === "CryptoWithdrawal");
    // Claimed from pending before anything was sent…
    expect(patches[0].where).toMatchObject({
      approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL,
    });
    expect(patches[0].patch).toMatchObject({
      approvalStatus: WithdrawalApprovalStatus.APPROVED,
      kind: "customer_payout",
    });
    // …then the payout id stored, and its status applied.
    expect(patches.some((p) => p.patch.pay21WithdrawalId === "p21-cp1")).toBe(true);
    expect(patches.some((p) => p.patch.remoteStatus === "approved")).toBe(true);
  });

  it("sends nothing when another admin decided first", async () => {
    const { service, client } = build({
      config: HD,
      withdrawal: hdPending(),
      destination: HD_DEST,
      approveClaimAffected: 0,
    });
    await expect(service.approve("admin-1", "w1")).rejects.toThrow(/already been decided/);
    expect(client.createCustomerPayout).not.toHaveBeenCalled();
  });

  it("will not let someone approve their own withdrawal", async () => {
    const { service, client } = build({ config: HD, withdrawal: hdPending(), destination: HD_DEST });
    await expect(service.approve("u1", "w1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.createCustomerPayout).not.toHaveBeenCalled();
  });

  it.each([400, 403, 422, 429])(
    "a definite refusal (%i) puts it back in the queue and refunds nothing",
    async (status) => {
      const { service, client, updates, saved } = build({
        config: HD,
        withdrawal: hdPending(),
        destination: HD_DEST,
      });
      client.createCustomerPayout.mockRejectedValue(upstream(status));

      await expect(service.approve("admin-1", "w1")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const revert = updates.find(
        (u) =>
          u.entity === "CryptoWithdrawal" &&
          u.patch.approvalStatus === WithdrawalApprovalStatus.PENDING_APPROVAL,
      );
      expect(revert).toBeDefined();
      // Only reverted if no payout id was stored in the meantime.
      expect(revert!.where).toMatchObject({ approvalStatus: WithdrawalApprovalStatus.APPROVED });
      expect(refunds(saved)).toHaveLength(0);
    },
  );

  it.each([
    ["a timeout", new Error("Twenty-one Pay POST /customer-payouts timed out after 15000ms")],
    ["a 5xx", upstream(502)],
    ["a network error", new TypeError("fetch failed")],
  ])(
    "an unknown outcome (%s) stays approved — never back to the queue, never refunded",
    async (_label, err) => {
      const { service, client, updates, saved } = build({
        config: HD,
        withdrawal: hdPending(),
        destination: HD_DEST,
      });
      client.createCustomerPayout.mockRejectedValue(err);

      await expect(service.approve("admin-1", "w1")).resolves.toBeDefined();
      expect(
        updates.some(
          (u) => u.patch.approvalStatus === WithdrawalApprovalStatus.PENDING_APPROVAL,
        ),
      ).toBe(false);
      expect(refunds(saved)).toHaveLength(0);
    },
  );

  it("a 409 holds it for review: not re-queued, not refunded", async () => {
    const { service, client, updates, saved } = build({
      config: HD,
      withdrawal: hdPending(),
      destination: HD_DEST,
    });
    client.createCustomerPayout.mockRejectedValue(upstream(409));
    await service.approve("admin-1", "w1");

    expect(updates.some((u) => u.patch.needsManualReview === true)).toBe(true);
    expect(
      updates.some((u) => u.patch.approvalStatus === WithdrawalApprovalStatus.PENDING_APPROVAL),
    ).toBe(false);
    expect(refunds(saved)).toHaveLength(0);
  });

  it("refunds once when 21 Pay rejects on the spot", async () => {
    const { service, client, saved } = build({
      config: HD,
      withdrawal: hdPending(),
      destination: HD_DEST,
    });
    client.createCustomerPayout.mockResolvedValue({
      id: "p21-cp1",
      status: "rejected",
      failure_reason: "sanctions",
    });
    await service.approve("admin-1", "w1");

    expect(refunds(saved)).toHaveLength(1);
    expect(Number(refunds(saved)[0].value.amount)).toBe(10);
  });

  it("refuses a saved address that is not a valid Tron address", async () => {
    const { service, client } = build({
      config: HD,
      withdrawal: hdPending(),
      destination: { ...HD_DEST, address: "not-an-address" },
    });
    await expect(service.approve("admin-1", "w1")).rejects.toThrow(/not a valid/);
    expect(client.createCustomerPayout).not.toHaveBeenCalled();
  });

  it("refuses while the address is in cooldown, before calling 21 Pay", async () => {
    const { service, client } = build({
      config: HD,
      withdrawal: hdPending(),
      destination: { ...HD_DEST, usableAt: new Date(Date.now() + 3_600_000) },
    });
    await expect(service.approve("admin-1", "w1")).rejects.toThrow(/cooldown/);
    expect(client.createCustomerPayout).not.toHaveBeenCalled();
  });
});

describe("HD: re-sending an unconfirmed approval", () => {
  it("re-sends with the same key and stores the payout it gets back", async () => {
    const approvedNoId = {
      ...hdPending(),
      approvalStatus: WithdrawalApprovalStatus.APPROVED,
      kind: "customer_payout",
      approvedAt: new Date(Date.now() - 5 * 60_000),
    };
    const { service, client, withdrawalRepo, updates } = build({
      config: HD,
      withdrawal: approvedNoId,
      destination: HD_DEST,
    });
    withdrawalRepo.find.mockResolvedValue([approvedNoId]);

    await service.resubmitUnconfirmed();

    expect(client.createCustomerPayout).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "wd:u1:r1" }),
    );
    expect(updates.some((u) => u.patch.pay21WithdrawalId === "p21-cp1")).toBe(true);
    // Only rows that are approved, have no payout id, and are not under review.
    expect(withdrawalRepo.find.mock.calls[0][0].where).toMatchObject({
      approvalStatus: WithdrawalApprovalStatus.APPROVED,
      needsManualReview: false,
    });
  });
});

describe("HD: withdrawal webhooks", () => {
  const submitted = () => ({
    ...hdPending(),
    approvalStatus: WithdrawalApprovalStatus.APPROVED,
    kind: "customer_payout",
    pay21WithdrawalId: "p21-cp1",
    remoteStatus: "approved",
  });

  it("completed → marked paid, nothing refunded, from 21 Pay's current record", async () => {
    const wd = submitted();
    const { service, client, updates, saved } = build({ config: HD, withdrawal: wd });
    client.getWithdrawal.mockResolvedValue({ id: "p21-cp1", status: "completed", tx_hash: "aa99" });

    const out = await service.handleWebhook({
      id: "p21-cp1",
      status: "completed",
      idempotency_key: "wd:u1:r1",
    });

    expect(out.handled).toBe(true);
    expect(client.getWithdrawal).toHaveBeenCalledWith("p21-cp1");
    expect(updates.some((u) => u.patch.completedAt instanceof Date)).toBe(true);
    expect(refunds(saved)).toHaveLength(0);
  });

  it.each(["rejected", "failed"])(
    "%s with no tx hash → refunded exactly once",
    async (status) => {
      const wd = submitted();
      const { service, client, saved } = build({ config: HD, withdrawal: wd });
      client.getWithdrawal.mockResolvedValue({ id: "p21-cp1", status, failure_reason: "x" });

      await service.handleWebhook({ id: "p21-cp1", status, idempotency_key: "wd:u1:r1" });
      expect(refunds(saved)).toHaveLength(1);
    },
  );

  it("failed WITH a tx hash → held for review, not refunded", async () => {
    const wd = submitted();
    const { service, client, saved, updates } = build({ config: HD, withdrawal: wd });
    client.getWithdrawal.mockResolvedValue({ id: "p21-cp1", status: "failed", tx_hash: "aa99" });

    await service.handleWebhook({ id: "p21-cp1", status: "failed", idempotency_key: "wd:u1:r1" });
    expect(refunds(saved)).toHaveLength(0);
    expect(updates.some((u) => u.patch.needsManualReview === true)).toBe(true);
  });

  it("acts on 21 Pay's current state, not the event body", async () => {
    // A late `failed` body for a payout 21 Pay now reports completed.
    const wd = submitted();
    const { service, client, saved } = build({ config: HD, withdrawal: wd });
    client.getWithdrawal.mockResolvedValue({ id: "p21-cp1", status: "completed", tx_hash: "aa99" });

    await service.handleWebhook({ id: "p21-cp1", status: "failed", idempotency_key: "wd:u1:r1" });
    expect(refunds(saved)).toHaveLength(0);
  });

  it("adopts the payout id by our key when the submit response was lost", async () => {
    const wd = { ...submitted(), pay21WithdrawalId: null };
    const { service, client, updates } = build({
      config: HD,
      findWithdrawal: (where) => (where.idempotencyKey === "wd:u1:r1" ? wd : null),
    });
    client.getWithdrawal.mockResolvedValue({ id: "p21-cp1", status: "broadcasting" });

    const out = await service.handleWebhook({
      id: "p21-cp1",
      status: "broadcasting",
      idempotency_key: "wd:u1:r1",
    });
    expect(out.handled).toBe(true);
    expect(updates.some((u) => u.patch.pay21WithdrawalId === "p21-cp1")).toBe(true);
  });

  it("never adopts a payout for a withdrawal we did not approve", async () => {
    const wd = hdPending(); // still pending
    const { service, client } = build({
      config: HD,
      findWithdrawal: (where) => (where.idempotencyKey === "wd:u1:r1" ? wd : null),
    });
    const out = await service.handleWebhook({ id: "p21-x", idempotency_key: "wd:u1:r1" });
    expect(out).toEqual({ handled: false, reason: "not_approved" });
    expect(client.getWithdrawal).not.toHaveBeenCalled();
  });

  it("ignores a payout whose key does not match the withdrawal", async () => {
    const wd = submitted();
    const { service, client } = build({ config: HD, withdrawal: wd });
    const out = await service.handleWebhook({ id: "p21-cp1", idempotency_key: "wd:someone:else" });
    expect(out.reason).toBe("key_mismatch");
    expect(client.getWithdrawal).not.toHaveBeenCalled();
  });

  it("ignores a payout we know nothing about", async () => {
    const { service, client } = build({ config: HD, findWithdrawal: () => null });
    const out = await service.handleWebhook({ id: "p21-zz", idempotency_key: "wd:u9:r9" });
    expect(out).toEqual({ handled: false, reason: "unknown_withdrawal" });
    expect(client.getWithdrawal).not.toHaveBeenCalled();
  });
});

describe("reject vs approve race", () => {
  it("a reject that lost the race refunds nothing", async () => {
    const { service, saved } = build({
      config: HD,
      withdrawal: hdPending(),
      rejectClaimAffected: 0,
    });
    await expect(service.reject("admin-2", "w1", "Suspicious")).rejects.toThrow(
      /already been decided/,
    );
    expect(refunds(saved)).toHaveLength(0);
  });

  it("a reject that won refunds once and records the decision", async () => {
    const { service, saved, updates } = build({ config: HD, withdrawal: hdPending() });
    await service.reject("admin-2", "w1", "Suspicious");
    expect(refunds(saved)).toHaveLength(1);
    expect(
      updates.some(
        (u) =>
          u.patch.approvalStatus === WithdrawalApprovalStatus.REJECTED &&
          u.where.approvalStatus === WithdrawalApprovalStatus.PENDING_APPROVAL,
      ),
    ).toBe(true);
  });
});
