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
          : 1;
      return Promise.resolve({ affected });
    }),
  };

  const withdrawalRepo: any = {
    findOneBy: jest.fn().mockResolvedValue(opts.withdrawal ?? null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((d: any) => ({ id: "w1", ...d })),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
    update: jest.fn().mockImplementation((where: any, patch: any) => {
      updates.push({ entity: "CryptoWithdrawal", where, patch });
      // The COMPLETED transition claim is conditional on completedAt IS NULL;
      // let a test force it to match 0 rows (another replica already completed).
      const affected =
        patch?.completedAt !== undefined ? opts.completedClaimAffected ?? 1 : 1;
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
  };
  const config: any = { get: (_k: string, d: string) => d };

  const userNotifRepo = {
    create: (e: any) => e,
    save: async (n: any) => {
      notifications.push(n);
      return n;
    },
  };
  const service = new CryptoWithdrawalService(
    withdrawalRepo,
    destRepo,
    userRepo,
    ds,
    client,
    config,
    userNotifRepo as any,
  );
  return {
    service,
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

  it("explains the 24h cooldown rather than refusing blankly", async () => {
    // A winner who cannot be paid for 24 hours needs to know why, or the
    // product looks broken at exactly the moment it matters most.
    const usableAt = new Date("2026-01-02T00:00:00Z");
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
    const patch = updates.find((u) => u.entity === "CryptoWithdrawal")!.patch;
    expect(patch.approvalStatus).toBe(WithdrawalApprovalStatus.APPROVED);
    expect(patch.pay21WithdrawalId).toBe("p21-w1");
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
