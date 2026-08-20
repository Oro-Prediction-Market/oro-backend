import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { EmailAuthService } from "../auth/email-auth.service";
import { AuthProvider } from "../entities/auth-method.entity";
import { KycStatus } from "../entities/user.entity";

function build(opts: { identity?: any; user?: any } = {}) {
  const saved: { entity: string; value: any }[] = [];
  const updates: any[] = [];
  const store = new Map<string, any>();
  const emails: any[] = [];

  const userRepo: any = {
    // `findOne` answers "does an account already hold this address" — null
    // means no. `findOneBy` reloads a user for session issuance and must
    // always return something, hence the stub fallback.
    findOne: jest.fn().mockResolvedValue(opts.user ?? null),
    findOneBy: jest
      .fn()
      .mockResolvedValue(opts.user ?? { id: "new-user", isAdmin: false }),
    update: jest.fn().mockImplementation((where: any, patch: any) => {
      updates.push({ where, patch });
      return Promise.resolve(undefined);
    }),
  };
  const authMethodRepo: any = {
    findOne: jest.fn().mockResolvedValue(opts.identity ?? null),
  };
  const dataSource: any = {
    transaction: jest.fn().mockImplementation((cb: Function) =>
      cb({
        create: (_e: any, d: any) => ({ ...d }),
        save: (entity: any, d: any) => {
          const name = entity?.name ?? "unknown";
          const row = { id: name === "User" ? "new-user" : "am-1", ...d };
          saved.push({ entity: name, value: row });
          return Promise.resolve(row);
        },
        // Recorded into the same array as repository updates, so assertions do
        // not care whether a write went through the repo or the transaction.
        update: (_e: any, where: any, patch: any) => {
          updates.push({ where, patch });
          return Promise.resolve(undefined);
        },
      }),
    ),
  };
  const redis: any = {
    setJsonEx: jest.fn().mockImplementation((k: string, _t: number, v: any) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    getJson: jest.fn().mockImplementation((k: string) =>
      Promise.resolve(store.has(k) ? store.get(k) : null),
    ),
    del: jest.fn().mockImplementation((...keys: string[]) => {
      keys.forEach((k) => store.delete(k));
      return Promise.resolve();
    }),
  };
  const email: any = {
    sendEmail: jest.fn().mockImplementation((o: any) => {
      emails.push(o);
      return Promise.resolve(true);
    }),
  };
  const jwt: any = { sign: jest.fn().mockReturnValue("jwt-token") };

  const service = new EmailAuthService(
    userRepo,
    authMethodRepo,
    dataSource,
    jwt,
    redis,
    email,
  );
  return { service, saved, updates, store, emails, userRepo, authMethodRepo };
}

/** Pull the token out of the message the service just sent. */
function tokenFrom(emails: any[]): string {
  return emails[emails.length - 1].text.match(/\b[0-9a-f]{64}\b/)[0];
}

describe("EmailAuthService.register", () => {
  it("creates a USDT account that is unverified and cannot yet deposit", async () => {
    const { service, saved } = build();
    await service.register("Global@Example.COM", "correct horse battery");

    const user = saved.find((r) => r.entity === "User")!.value;
    expect(user.currency).toBe("USDT");
    expect(user.kycStatus).toBe(KycStatus.NONE);
    expect(user.emailVerifiedAt).toBeUndefined();
  });

  it("stores the identity under the normalised address", async () => {
    // auth_methods is unique on (provider, providerId); without normalising on
    // write, Global@Example.COM and global@example.com are two accounts and
    // the constraint cannot tell they are one person.
    const { service, saved } = build();
    await service.register("Global@Example.COM", "correct horse battery");

    const identity = saved.find((r) => r.entity === "AuthMethod")!.value;
    expect(identity.provider).toBe(AuthProvider.EMAIL);
    expect(identity.providerId).toBe("global@example.com");
    expect(saved.find((r) => r.entity === "User")!.value.email).toBe(
      "global@example.com",
    );
  });

  it("hashes the password rather than storing it", async () => {
    const { service, saved } = build();
    await service.register("a@b.com", "correct horse battery");
    const user = saved.find((r) => r.entity === "User")!.value;
    expect(user.pwaPasswordHash).not.toBe("correct horse battery");
    expect(await bcrypt.compare("correct horse battery", user.pwaPasswordHash)).toBe(true);
  });

  it("does not reveal that an address is already registered", async () => {
    // Same response either way. A distinct "already taken" turns this route
    // into a free check for which addresses hold an account.
    const fresh = build();
    const taken = build({ identity: { userId: "u1", providerId: "a@b.com" } });

    const r1 = await fresh.service.register("a@b.com", "correct horse battery");
    const r2 = await taken.service.register("a@b.com", "correct horse battery");

    expect(r2).toEqual(r1);
    expect(taken.saved.filter((r) => r.entity === "User")).toHaveLength(0);
  });

  it("rejects malformed addresses and weak passwords", async () => {
    const { service } = build();
    await expect(service.register("not-an-email", "correct horse battery"))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.register("a@b.com", "short")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("EmailAuthService.verify", () => {
  it("marks the address verified and consumes the token", async () => {
    const { service, updates, emails } = build();
    await service.register("a@b.com", "correct horse battery");
    const token = tokenFrom(emails);

    await expect(service.verify(token)).resolves.toEqual({ verified: true });
    expect(updates[0].patch.emailVerifiedAt).toBeInstanceOf(Date);

    // Single use: a leaked link cannot be replayed.
    await expect(service.verify(token)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects an unknown token", async () => {
    const { service } = build();
    await expect(service.verify("deadbeef")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("EmailAuthService.login", () => {
  const makeUser = async (password: string) => ({
    id: "u1",
    isAdmin: false,
    pwaPasswordHash: await bcrypt.hash(password, 4),
  });

  it("issues a token for the right password", async () => {
    const user = await makeUser("correct horse battery");
    const { service } = build({
      identity: { userId: "u1", providerId: "a@b.com" },
      user,
    });
    const res = await service.login("A@B.com", "correct horse battery");
    expect(res.token).toBe("jwt-token");
  });

  it("gives one message for every failure", async () => {
    // Unknown address, no password set and wrong password must be
    // indistinguishable, or the route says which addresses are worth attacking.
    const user = await makeUser("correct horse battery");
    const cases = [
      build({ identity: null }),
      build({ identity: { userId: "u1" }, user: { id: "u1", pwaPasswordHash: null } }),
      build({ identity: { userId: "u1" }, user }),
    ];
    const messages: string[] = [];
    for (const [i, c] of cases.entries()) {
      await c.service.login("a@b.com", i === 2 ? "wrong password!!" : "correct horse battery")
        .catch((e) => messages.push(e.message));
    }
    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe("Invalid email or password");
  });

  it("never returns the password hash", async () => {
    const user = { ...(await makeUser("correct horse battery")), email: "a@b.com" };
    const { service } = build({ identity: { userId: "u1" }, user });
    const res = await service.login("a@b.com", "correct horse battery");
    expect(res.user).not.toHaveProperty("pwaPasswordHash");
  });
});

describe("EmailAuthService password reset", () => {
  it("reports success for an unknown address without sending anything", async () => {
    const { service, emails } = build({ identity: null });
    await expect(service.requestReset("nobody@example.com")).resolves.toEqual({
      status: "sent",
    });
    expect(emails).toHaveLength(0);
  });

  it("resets the password once, then the token is dead", async () => {
    const { service, emails, updates } = build({
      identity: { userId: "u1", providerId: "a@b.com" },
    });
    await service.requestReset("a@b.com");
    const token = tokenFrom(emails);

    await expect(service.completeReset(token, "a whole new password")).resolves.toEqual(
      { status: "reset" },
    );
    const hash = updates[0].patch.pwaPasswordHash;
    expect(await bcrypt.compare("a whole new password", hash)).toBe(true);

    await expect(
      service.completeReset(token, "another new password"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("will not set a weak password", async () => {
    const { service, emails } = build({ identity: { userId: "u1" } });
    await service.requestReset("a@b.com");
    await expect(
      service.completeReset(tokenFrom(emails), "short"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Google Sign-In ───────────────────────────────────────────────────────────

const GOOGLE_PAYLOAD = {
  sub: "google-sub-123",
  email: "global@example.com",
  email_verified: true,
  given_name: "Ada",
  family_name: "Lovelace",
  picture: "https://example/pic.png",
  name: "Ada Lovelace",
};

/** Swap the verifier so no test reaches Google. */
function withGoogle(service: any, payload: any | null) {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  service.google = () => ({
    verifyIdToken: async () => {
      if (payload === null) throw new Error("bad token");
      return { getPayload: () => payload };
    },
  });
  return service;
}

describe("EmailAuthService.loginWithGoogle", () => {
  it("creates a verified USDT account on first sign-in", async () => {
    const { service, saved } = build();
    withGoogle(service, GOOGLE_PAYLOAD);

    const res = await service.loginWithGoogle("tok");

    expect(res.isNew).toBe(true);
    const user = saved.find((r) => r.entity === "User")!.value;
    expect(user.currency).toBe("USDT");
    expect(user.kycStatus).toBe(KycStatus.NONE);
    // Google already proved the address; our verification email adds nothing.
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.email).toBe("global@example.com");
  });

  it("keys the identity on Google's subject, not the email", async () => {
    // Someone can rename the address on a Google account. `sub` is stable, so
    // keying on email would silently detach the identity when they do.
    const { service, saved } = build();
    withGoogle(service, GOOGLE_PAYLOAD);
    await service.loginWithGoogle("tok");

    const identity = saved.find((r) => r.entity === "AuthMethod")!.value;
    expect(identity.provider).toBe(AuthProvider.GOOGLE);
    expect(identity.providerId).toBe("google-sub-123");
  });

  it("returns the existing account on a repeat sign-in", async () => {
    const { service, saved } = build({
      identity: { userId: "u1", providerId: "google-sub-123" },
      user: { id: "u1", isAdmin: false },
    });
    withGoogle(service, GOOGLE_PAYLOAD);

    const res = await service.loginWithGoogle("tok");
    expect(res.isNew).toBe(false);
    expect(saved.filter((r) => r.entity === "User")).toHaveLength(0);
  });

  it("refuses a Google account whose email is unverified", async () => {
    // Treating an unverified Google address as proof of ownership is the whole
    // vulnerability.
    const { service } = build();
    withGoogle(service, { ...GOOGLE_PAYLOAD, email_verified: false });
    await expect(service.loginWithGoogle("tok")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("refuses a token that does not verify", async () => {
    const { service } = build();
    withGoogle(service, null);
    await expect(service.loginWithGoogle("tok")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("refuses an empty credential without calling Google", async () => {
    const { service } = build();
    withGoogle(service, GOOGLE_PAYLOAD);
    await expect(service.loginWithGoogle("")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("attributes a referral on a new Google account", async () => {
    const { service, saved, userRepo } = build();
    withGoogle(service, GOOGLE_PAYLOAD);
    // Two different lookups hit the same repo: "does this address exist" and
    // "who owns this referral code". Answer each on its own terms.
    userRepo.findOne = jest.fn().mockImplementation((q: any) =>
      Promise.resolve(
        q?.where?.telegramId === "555" ? { id: "referrer-1" } : null,
      ),
    );

    await service.loginWithGoogle("tok", "ref_555");

    const user = saved.find((r) => r.entity === "User")!.value;
    expect(user.referredByUserId).toBe("referrer-1");
  });

  it("ignores an unknown referral code rather than failing the signup", async () => {
    // A stale or hand-typed link must never cost us the account.
    const { service, saved } = build();
    withGoogle(service, GOOGLE_PAYLOAD);

    const res = await service.loginWithGoogle("tok", "ref_nobody");

    expect(res.isNew).toBe(true);
    expect(saved.find((r) => r.entity === "User")!.value.referredByUserId)
      .toBeUndefined();
  });

  it("does not re-attribute a referral to an account that already exists", async () => {
    // Otherwise anyone could re-refer an existing user by sending them a link.
    const { service, updates } = build({
      identity: { userId: "u1", providerId: "google-sub-123" },
      user: { id: "u1", isAdmin: false },
    });
    withGoogle(service, GOOGLE_PAYLOAD);

    await service.loginWithGoogle("tok", "ref_555");

    expect(
      updates.some((u) => "referredByUserId" in (u.patch ?? {})),
    ).toBe(false);
  });


  it("reports an unconfigured deployment as unavailable, not a failed sign-in", async () => {
    // These are opposite faults. A 401 tells the user to go check their Google
    // account; the actual problem is a missing client id on our side.
    const { service } = build();
    const prev = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      await expect(service.loginWithGoogle("tok")).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      process.env.GOOGLE_CLIENT_ID = prev;
    }
  });

});

describe("EmailAuthService — linking Google to an address we already hold", () => {
  it("links without touching the password when the account was verified", async () => {
    // Both sides have proven ownership; there is nothing to defend against.
    const { service, saved, updates } = build({
      identity: null,
      user: {
        id: "u1",
        email: "global@example.com",
        emailVerifiedAt: new Date("2026-01-01"),
        pwaPasswordHash: "existing-hash",
      },
    });
    withGoogle(service, GOOGLE_PAYLOAD);

    const res = await service.loginWithGoogle("tok");

    expect(res.isNew).toBe(false);
    expect(saved.some((r) => r.entity === "AuthMethod")).toBe(true);
    expect(updates[0].patch).not.toHaveProperty("pwaPasswordHash");
  });

  it("clears the password when linking to an UNVERIFIED account", async () => {
    // The attack: someone registers victim@gmail with a password and never
    // verifies it. When the real owner signs in with Google, linking as-is
    // hands them an account whose password the attacker knows. Google's
    // verified claim is the stronger evidence, so the unproven password goes.
    const { service, updates } = build({
      identity: null,
      user: {
        id: "u1",
        email: "global@example.com",
        emailVerifiedAt: null,
        pwaPasswordHash: "attacker-set-hash",
      },
    });
    withGoogle(service, GOOGLE_PAYLOAD);

    await service.loginWithGoogle("tok");

    expect(updates[0].patch.pwaPasswordHash).toBeNull();
    expect(updates[0].patch.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("never creates a second account for an address already held", async () => {
    // users.email is unique, so a second insert would fail anyway — this
    // asserts we link deliberately rather than lean on a constraint error.
    const { service, saved } = build({
      identity: null,
      user: {
        id: "u1",
        email: "global@example.com",
        emailVerifiedAt: new Date(),
      },
    });
    withGoogle(service, GOOGLE_PAYLOAD);

    await service.loginWithGoogle("tok");
    expect(saved.filter((r) => r.entity === "User")).toHaveLength(0);
  });
});
