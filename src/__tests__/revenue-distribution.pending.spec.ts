/**
 * Revenue distributions whose DK transfer came back indeterminate.
 *
 * A platform-fee transfer that DK accepted but has not settled must never
 * leave its rows selectable again. `processAllPending` sends every PENDING row
 * as ONE combined transfer, so a batch released on an unknown outcome is not
 * one double payment — it is the whole batch paid twice the moment an admin
 * clicks again.
 *
 * The rule is the same one the withdrawal path follows: only a definite answer
 * moves a row, and "we do not know yet" holds it exactly where it is.
 */
import { IsNull } from "typeorm";
import { RevenueDistributionService } from "../markets/revenue-distribution.service";
import { DistributionStatus } from "../entities/revenue-distribution.entity";

const PUBLIC_ACCOUNT = "220000000009";

function makeDist(overrides: any = {}) {
  return {
    id: "dist-1",
    marketId: "market-1",
    challengeId: null,
    amount: "24.00",
    status: DistributionStatus.PENDING,
    publicAccountNo: PUBLIC_ACCOUNT,
    pendingTransferRef: null,
    ...overrides,
  };
}

function build(rows: any[]) {
  const distributionRepo: any = {
    findOne: jest.fn().mockResolvedValue(rows[0]),
    find: jest.fn().mockResolvedValue(rows),
    update: jest.fn().mockResolvedValue({}),
  };
  const dkGateway: any = {
    transferToAccount: jest.fn(),
    checkTransferStatus: jest.fn(),
  };
  const configService: any = { get: () => PUBLIC_ACCOUNT };
  const redisService: any = {
    acquireLock: jest.fn().mockResolvedValue("t"),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new RevenueDistributionService(
    distributionRepo,
    {} as any,
    {} as any,
    configService,
    dkGateway,
    redisService,
  );
  return { svc, distributionRepo, dkGateway };
}

/** The partial passed to distributionRepo.update for a given row id. */
const updateFor = (repo: any, id: string) =>
  repo.update.mock.calls.filter((c: any[]) => c[0] === id).map((c: any[]) => c[1]);

describe("executeTransfer — indeterminate outcome", () => {
  it("holds the row at PENDING instead of failing it", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      statusDesc: "Transfer status indeterminate",
      paymentNumber: "PN-123",
      requestId: "REQ-9",
    });

    await svc.executeTransfer("dist-1");

    const writes = updateFor(distributionRepo, "dist-1");
    expect(writes.some((w: any) => w.status === DistributionStatus.FAILED)).toBe(false);
    expect(writes.some((w: any) => w.status === DistributionStatus.COMPLETED)).toBe(false);
  });

  it("stamps the DK reference so the row cannot be sent again", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: "PN-123",
      requestId: "REQ-9",
    });

    await svc.executeTransfer("dist-1");

    expect(updateFor(distributionRepo, "dist-1")).toContainEqual(
      expect.objectContaining({ pendingTransferRef: "PN-123" }),
    );
  });

  it("falls back to the request id when DK sends no payment number", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: null,
      requestId: "REQ-9",
    });

    await svc.executeTransfer("dist-1");

    expect(updateFor(distributionRepo, "dist-1")).toContainEqual(
      expect.objectContaining({ pendingTransferRef: "REQ-9" }),
    );
  });

  it("reports it as not-yet-successful to the admin who triggered it", async () => {
    const dist = makeDist();
    const { svc, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: "PN-123",
    });

    const res = await svc.executeTransfer("dist-1");

    expect(res.success).toBe(false);
  });

  it("refuses to re-send a row that already has a transfer at the bank", async () => {
    const dist = makeDist({ pendingTransferRef: "PN-123" });
    const { svc, dkGateway } = build([dist]);

    const res = await svc.executeTransfer("dist-1");

    expect(res.success).toBe(false);
    expect(dkGateway.transferToAccount).not.toHaveBeenCalled();
  });

  // Worst case: DK neither settled it nor gave us anything to ask about later.
  // The row still must not be sendable — a held row needing a human beats a
  // free row that pays the fee twice on the next click.
  it("holds the row even when DK returns no reference at all", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: null,
      requestId: null,
      txnId: null,
    });

    await svc.executeTransfer("dist-1");

    const stamped = updateFor(distributionRepo, "dist-1").find(
      (w: any) => w.pendingTransferRef,
    );
    expect(stamped).toBeDefined();
  });

  // reference_no accepts a payment_number, a txn_status_id or our request id —
  // not an inquiry_id, which is what `txnId` falls back to. Stamping one would
  // have the resolver ask DK about a handle it never issued, on every sweep.
  it("does not stamp a handle DK's status API will not accept", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: null,
      requestId: null,
      txnStatusId: null,
      txnId: "Oro-PAYOUT-inquiry-id",
    });

    await svc.executeTransfer("dist-1");

    const stamped = updateFor(distributionRepo, "dist-1").find(
      (w: any) => w.pendingTransferRef,
    );
    expect(stamped.pendingTransferRef).toMatch(/^MANUAL-/);
  });

  it("stamps a txn_status_id, which the status API does accept", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: null,
      requestId: null,
      txnStatusId: "S-77",
    });

    await svc.executeTransfer("dist-1");

    expect(updateFor(distributionRepo, "dist-1")).toContainEqual(
      expect.objectContaining({ pendingTransferRef: "S-77" }),
    );
  });

  it("still fails a definite rejection, where no money moved", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "FAILED",
      statusDesc: "Record not found",
    });

    await svc.executeTransfer("dist-1");

    expect(updateFor(distributionRepo, "dist-1")).toContainEqual(
      expect.objectContaining({ status: DistributionStatus.FAILED }),
    );
  });

  it("still completes a settled transfer", async () => {
    const dist = makeDist();
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "SUCCESS",
      txnId: "T1",
    });

    await svc.executeTransfer("dist-1");

    expect(updateFor(distributionRepo, "dist-1")).toContainEqual(
      expect.objectContaining({ status: DistributionStatus.COMPLETED }),
    );
  });
});

describe("processAllPending — indeterminate batch", () => {
  it("never selects a row whose transfer is already at the bank", async () => {
    const { svc, distributionRepo, dkGateway } = build([makeDist()]);
    dkGateway.transferToAccount.mockResolvedValue({ status: "SUCCESS", txnId: "T1" });

    await svc.processAllPending();

    expect(distributionRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: DistributionStatus.PENDING, pendingTransferRef: IsNull() },
      }),
    );
  });

  it("stamps every row in the batch, leaving none free to re-send", async () => {
    const rows = [makeDist({ id: "d1" }), makeDist({ id: "d2" }), makeDist({ id: "d3" })];
    const { svc, distributionRepo, dkGateway } = build(rows);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: "PN-BATCH",
    });

    await svc.processAllPending();

    for (const id of ["d1", "d2", "d3"]) {
      expect(updateFor(distributionRepo, id)).toContainEqual(
        expect.objectContaining({ pendingTransferRef: "PN-BATCH" }),
      );
    }
  });

  it("does not complete or fail the batch on an indeterminate answer", async () => {
    const rows = [makeDist({ id: "d1" }), makeDist({ id: "d2" })];
    const { svc, distributionRepo, dkGateway } = build(rows);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: "PN-BATCH",
    });

    await svc.processAllPending();

    const statuses = distributionRepo.update.mock.calls.map((c: any[]) => c[1].status);
    expect(statuses.every((s: any) => s === undefined)).toBe(true);
  });

  // A transport timeout is exactly when DK may have received and processed the
  // transfer. Unlike executeTransfer, a thrown batch call leaves its rows at
  // PENDING, so without a hold the next click re-sends all of them.
  it("holds the batch when the transfer call throws", async () => {
    const rows = [makeDist({ id: "d1" }), makeDist({ id: "d2" })];
    const { svc, distributionRepo, dkGateway } = build(rows);
    dkGateway.transferToAccount.mockRejectedValue(new Error("socket hang up"));

    await svc.processAllPending();

    for (const id of ["d1", "d2"]) {
      expect(updateFor(distributionRepo, id).find((w: any) => w.pendingTransferRef)).toBeDefined();
    }
  });

  // The regression this whole change exists to prevent.
  it("leaves no row selectable by a second click after an indeterminate batch", async () => {
    const rows = [makeDist({ id: "d1" }), makeDist({ id: "d2" })];
    const { svc, distributionRepo, dkGateway } = build(rows);
    dkGateway.transferToAccount.mockResolvedValue({
      status: "AMBIGUOUS",
      paymentNumber: "PN-BATCH",
    });

    await svc.processAllPending();

    const stamped = distributionRepo.update.mock.calls
      .filter((c: any[]) => c[1].pendingTransferRef)
      .map((c: any[]) => c[0]);
    expect(new Set(stamped)).toEqual(new Set(["d1", "d2"]));
  });
});

describe("resolvePendingTransfers", () => {
  it("asks DK about the account the fee was paid into", async () => {
    const dist = makeDist({ pendingTransferRef: "PN-123" });
    const { svc, dkGateway } = build([dist]);
    dkGateway.checkTransferStatus.mockResolvedValue({ verdict: "pending" });

    await svc.resolvePendingTransfers();

    expect(dkGateway.checkTransferStatus).toHaveBeenCalledWith({
      referenceNo: "PN-123",
      beneAccountNumber: PUBLIC_ACCOUNT,
    });
  });

  it("completes a settled distribution and clears the hold", async () => {
    const dist = makeDist({ pendingTransferRef: "PN-123" });
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "success",
      paymentNumber: "PN-123",
    });

    await svc.resolvePendingTransfers();

    expect(updateFor(distributionRepo, "dist-1")).toContainEqual(
      expect.objectContaining({
        status: DistributionStatus.COMPLETED,
        pendingTransferRef: null,
      }),
    );
  });

  it("returns a refused distribution to the queue for the next run", async () => {
    const dist = makeDist({ pendingTransferRef: "PN-123" });
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "failed",
      statusDesc: "Rejected",
    });

    await svc.resolvePendingTransfers();

    expect(updateFor(distributionRepo, "dist-1")).toContainEqual(
      expect.objectContaining({
        status: DistributionStatus.PENDING,
        pendingTransferRef: null,
      }),
    );
  });

  it("holds a still-pending distribution exactly where it is", async () => {
    const dist = makeDist({ pendingTransferRef: "PN-123" });
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.checkTransferStatus.mockResolvedValue({ verdict: "pending" });

    await svc.resolvePendingTransfers();

    expect(distributionRepo.update).not.toHaveBeenCalled();
  });

  // A row with no real DK handle is held for a human. Asking DK about a
  // reference it never issued would just 3001 on every sweep forever.
  it("does not pester DK about a row that has no real reference", async () => {
    const dist = makeDist({ pendingTransferRef: "MANUAL-dist-1" });
    const { svc, distributionRepo, dkGateway } = build([dist]);

    await svc.resolvePendingTransfers();

    expect(dkGateway.checkTransferStatus).not.toHaveBeenCalled();
    expect(distributionRepo.update).not.toHaveBeenCalled();
  });

  it("holds the row when the status call itself fails", async () => {
    const dist = makeDist({ pendingTransferRef: "PN-123" });
    const { svc, distributionRepo, dkGateway } = build([dist]);
    dkGateway.checkTransferStatus.mockRejectedValue(new Error("socket hang up"));

    await svc.resolvePendingTransfers();

    expect(distributionRepo.update).not.toHaveBeenCalled();
  });
});
