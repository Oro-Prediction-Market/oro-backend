import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { CryptoDepositService } from "../payment/crypto-deposit.service";
import { KycStatus } from "../entities/user.entity";
import { CryptoIntentStatus } from "../entities/crypto-payment-intent.entity";

const APPROVED_USDT = {
  id: "u1",
  currency: "USDT",
  kycStatus: KycStatus.APPROVED,
};

function build(opts: {
  user?: any;
  existingIntent?: any;
  enabled?: boolean;
  createdStatus?: string;
  configured?: string[];
  networksError?: boolean;
} = {}) {
  const saved: any[] = [];
  const intentRepo: any = {
    findOneBy: jest.fn().mockResolvedValue(opts.existingIntent ?? null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((d: any) => ({ id: "local-1", ...d })),
    save: jest.fn().mockImplementation((d: any) => {
      saved.push(d);
      return Promise.resolve(d);
    }),
  };
  const userRepo: any = {
    findOneBy: jest.fn().mockResolvedValue(
      opts.user === undefined ? APPROVED_USDT : opts.user,
    ),
  };
  const client: any = {
    enabled: opts.enabled ?? true,
    intentTtlMinutes: 30,
    enabledNetworks: opts.configured ?? ["tron", "base"],
    listNetworks: jest.fn().mockResolvedValue({
      networks: opts.networksError
        ? []
        : [
            { network: "tron", status: "active", activated: true },
            { network: "base", status: "available", activated: false },
            { network: "polygon", status: "available", activated: false },
          ],
    }),
    isNetworkEnabled: jest.fn().mockReturnValue(true),
    createPaymentIntent: jest.fn().mockResolvedValue({
      id: "pay21-1",
      status: opts.createdStatus ?? "awaiting_deposit",
      deposit_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    }),
    createTopup: jest.fn().mockResolvedValue({
      id: "pay21-child",
      status: "awaiting_deposit",
      deposit_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      amount: "5000000",
    }),
  };
  const config: any = {
    get: (k: string, d: string) =>
      ({ USDT_MIN_DEPOSIT: "1", USDT_MAX_DEPOSIT: "1000" })[k] ?? d,
  };
  const service = new CryptoDepositService(intentRepo, userRepo, client, config);
  return { service, saved, client, intentRepo };
}

const req = { network: "tron", amountUsdt: "10", clientRequestId: "req-1" };

describe("CryptoDepositService.createIntent — guards", () => {
  it("creates an intent for an approved USDT account", async () => {
    const { service, saved, client } = build();
    const view = await service.createIntent("u1", req);

    expect(client.createPaymentIntent).toHaveBeenCalled();
    expect(view.depositAddress).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(view.amountBaseUnits).toBe("10000000");
    expect(saved[0].pay21IntentId).toBe("pay21-1");
  });

  it("refuses when the rail is disabled", async () => {
    const { service } = build({ enabled: false });
    await expect(service.createIntent("u1", req)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("refuses an account whose KYC is not approved", async () => {
    // Deposit is the KYC gate, not withdrawal: refusing here means a rejected
    // applicant never funded an account and nothing is in limbo.
    for (const s of [KycStatus.NONE, KycStatus.PENDING, KycStatus.REJECTED]) {
      const { service, client } = build({
        user: { ...APPROVED_USDT, kycStatus: s },
      });
      await expect(service.createIntent("u1", req)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(client.createPaymentIntent).not.toHaveBeenCalled();
    }
  });

  it("refuses a BTN account that has proved nothing", async () => {
    // No document, no DK Bank link — nothing establishes who this is.
    const { service } = build({
      user: {
        id: "u1",
        currency: "BTN",
        kycStatus: KycStatus.NONE,
        dkAccountNumber: null,
      },
    });
    await expect(service.createIntent("u1", req)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets a Bhutanese account with an approved document deposit USDT", async () => {
    // A BTN account holds ngultrum natively and a USDT wallet beside it. The
    // two never mix: this credit is written with currency 'USDT' and every BTN
    // sum is scoped, so no ngultrum balance can move because of it.
    const { service, client } = build({
      user: {
        id: "u1",
        currency: "BTN",
        kycStatus: KycStatus.APPROVED,
        dkAccountNumber: null,
      },
    });
    await expect(service.createIntent("u1", req)).resolves.toBeDefined();
    expect(client.createPaymentIntent).toHaveBeenCalled();
  });

  it("accepts a linked DK Bank account in place of a document", async () => {
    // A verified CID is national identity checked by a bank — stronger than a
    // photographed passport read by a reviewer, so it does not also need one.
    const { service } = build({
      user: {
        id: "u1",
        currency: "BTN",
        kycStatus: KycStatus.NONE,
        dkAccountNumber: "200123456",
      },
    });
    await expect(service.createIntent("u1", req)).resolves.toBeDefined();
  });

  it("still refuses an unverified USDT-native account", async () => {
    // The regression guard. Being a USDT account is not evidence of anything —
    // one created through Google starts unverified, and the deposit gate is
    // the only thing stopping it funding itself.
    const { service } = build({
      user: {
        id: "u1",
        currency: "USDT",
        kycStatus: KycStatus.NONE,
        dkAccountNumber: null,
      },
    });
    await expect(service.createIntent("u1", req)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuses an unknown or disabled network", async () => {
    const { service } = build();
    await expect(
      service.createIntent("u1", { ...req, network: "ethereum" }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const off = build();
    off.client.isNetworkEnabled.mockReturnValue(false);
    await expect(off.service.createIntent("u1", req)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("never calls 21Pay when a guard fails", async () => {
    // A rejected request must not burn an HD derivation index.
    const { service, client } = build({ user: null });
    await expect(service.createIntent("u1", req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("CryptoDepositService — amount validation", () => {
  it("rejects more than six decimal places instead of truncating", async () => {
    // A truncated expectation never equals the detected amount, so every such
    // deposit would land as confirmed_partial — a support ticket created at
    // validation time.
    const { service } = build();
    await expect(
      service.createIntent("u1", { ...req, amountUsdt: "10.1234567" }),
    ).rejects.toThrow(/6 decimal places/);
  });

  it("accepts exactly six", async () => {
    const { service } = build();
    await expect(
      service.createIntent("u1", { ...req, amountUsdt: "10.123456" }),
    ).resolves.toMatchObject({ amountBaseUnits: "10123456" });
  });

  it("enforces our own floor and ceiling, because 21Pay enforces none", async () => {
    const { service } = build();
    await expect(
      service.createIntent("u1", { ...req, amountUsdt: "0.5" }),
    ).rejects.toThrow(/Minimum deposit/);
    await expect(
      service.createIntent("u1", { ...req, amountUsdt: "5000" }),
    ).rejects.toThrow(/Maximum deposit/);
  });

  it("rejects malformed amounts", async () => {
    const { service } = build();
    for (const bad of ["", "abc", "-5", "1e6", "1.2.3"]) {
      await expect(
        service.createIntent("u1", { ...req, amountUsdt: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe("CryptoDepositService — idempotency", () => {
  it("replays an existing intent instead of minting a second", async () => {
    const existing = {
      id: "local-1",
      userId: "u1",
      pay21IntentId: "pay21-1",
      network: "tron",
      depositAddress: "TRxxx",
      amountUsdt: 10,
      status: CryptoIntentStatus.AWAITING_DEPOSIT,
      expiresAt: new Date(),
      txHash: null,
      detectedAmountUsdt: null,
    };
    const { service, client } = build({ existingIntent: existing });

    const view = await service.createIntent("u1", req);
    expect(view.intentId).toBe("local-1");
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("CryptoDepositService — top-up", () => {
  const parent = {
    id: "local-1",
    userId: "u1",
    pay21IntentId: "pay21-1",
    network: "tron",
    depositAddress: "TRparent",
    amountUsdt: 10,
    expiresAt: new Date(),
    txHash: null,
    detectedAmountUsdt: null,
  };

  it("tops up an underpaid intent, reusing the parent's address", async () => {
    const { service, saved, intentRepo } = build();
    // First lookup resolves the parent; the second is the idempotency check
    // and must miss so a child is actually created.
    intentRepo.findOneBy = jest
      .fn()
      .mockResolvedValueOnce({
        ...parent,
        status: CryptoIntentStatus.CONFIRMED_PARTIAL,
      })
      .mockResolvedValueOnce(null);

    await service.createTopup("u1", "local-1", "req-2");

    // The child points at its parent and reuses the derived address, so a user
    // who already sent to it can simply send again.
    expect(saved[0].parentIntentId).toBe("pay21-1");
    expect(saved[0].depositAddress).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  });

  it("refuses to top up an intent in a state that cannot take one", async () => {
    for (const s of [
      CryptoIntentStatus.AWAITING_DEPOSIT,
      CryptoIntentStatus.CONFIRMED,
      CryptoIntentStatus.FAILED,
    ]) {
      const { service } = build({ existingIntent: { ...parent, status: s } });
      await expect(
        service.createTopup("u1", "local-1", "req-2"),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe("CryptoDepositService — ownership and views", () => {
  it("gives the same answer for someone else's intent as for a missing one", async () => {
    // Otherwise the route confirms which intent ids exist.
    const { service } = build({
      existingIntent: { id: "local-1", userId: "someone-else" },
    });
    await expect(service.getIntent("u1", "local-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const missing = build({ existingIntent: null });
    await expect(
      missing.service.getIntent("u1", "local-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("builds the explorer link server-side, per chain", async () => {
    const { service } = build({
      existingIntent: {
        id: "local-1",
        userId: "u1",
        network: "base",
        depositAddress: "0xabc",
        amountUsdt: 10,
        detectedAmountUsdt: null,
        status: CryptoIntentStatus.CONFIRMED,
        expiresAt: new Date(),
        txHash: "0xdeadbeef",
      },
    });
    const view = await service.getIntent("u1", "local-1");
    expect(view.explorerUrl).toBe("https://basescan.org/tx/0xdeadbeef");
  });

  it("has no explorer link before a hash exists", async () => {
    const { service } = build({
      existingIntent: {
        id: "local-1",
        userId: "u1",
        network: "tron",
        depositAddress: "TRxxx",
        amountUsdt: 10,
        detectedAmountUsdt: null,
        status: CryptoIntentStatus.AWAITING_DEPOSIT,
        expiresAt: new Date(),
        txHash: null,
      },
    });
    expect((await service.getIntent("u1", "local-1")).explorerUrl).toBeNull();
  });
});

describe("CryptoDepositService.availableNetworks", () => {
  it("offers only chains 21Pay has actually activated for us", async () => {
    // The gap this closes: `base` is configured and the engine supports it,
    // but our tenant has no xpub registered and no watcher running. A deposit
    // to a base address derived for us would simply be lost, so offering it is
    // worse than offering nothing.
    const { service } = build({ configured: ["tron", "base"] });
    const nets = await service.availableNetworks();

    expect(nets.map((n) => n.id)).toEqual(["tron"]);
  });

  it("ignores a chain that is activated but not configured", async () => {
    const { service } = build({ configured: [] });
    expect(await service.availableNetworks()).toEqual([]);
  });

  it("carries backend-owned display copy, including the Tron gas warning", async () => {
    // Names are spelled out, never chain ids: all three EVM chains share the
    // 0x format, so the name is the only thing between a user and an
    // unrecoverable wrong-chain send.
    const { service } = build({ configured: ["tron"] });
    const [tron] = await service.availableNetworks();

    expect(tron.name).toBe("Tron (TRC-20)");
    expect(tron.confirmationHint).toMatch(/minute/i);
    expect(tron.warning).toMatch(/TRX/);
  });

  it("offers nothing when 21Pay cannot be reached", async () => {
    // Deliberately not falling back to config. Guessing here means handing a
    // user a deposit address on a chain nobody is watching.
    const { service, client } = build({ configured: ["tron"] });
    client.listNetworks = jest.fn().mockRejectedValue(new Error("gateway down"));
    expect(await service.availableNetworks()).toEqual([]);
  });

  it("caches, so the picker does not hammer 21Pay", async () => {
    const { service, client } = build({ configured: ["tron"] });
    await service.availableNetworks();
    await service.availableNetworks();
    await service.availableNetworks();
    expect(client.listNetworks).toHaveBeenCalledTimes(1);
  });
});
