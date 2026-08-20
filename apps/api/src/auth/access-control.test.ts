import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationRequiredError,
  IdentityConfigurationError,
  resolveRequestSubject,
} from "./access-control.js";

describe("authentication modes", () => {
  const oidc = { verify: vi.fn(async () => "corp:user-42") };

  it("keeps the local bootstrap identity only in development", async () => {
    await expect(
      resolveRequestSubject({ headers: {} }, oidc, { NODE_ENV: "development" }),
    ).resolves.toBe("bootstrap:anna.sokolova");

    await expect(
      resolveRequestSubject({ headers: {} }, oidc, { NODE_ENV: "production" }),
    ).rejects.toBeInstanceOf(IdentityConfigurationError);
  });

  it("accepts a proxy subject only when trusted proxy mode is explicitly protected", async () => {
    await expect(
      resolveRequestSubject({ headers: { "x-embed-actor": "corp:user-42" } }, oidc, {
        NODE_ENV: "production",
        AUTH_MODE: "trusted_proxy",
        TRUSTED_IDENTITY_HEADER: "true",
      }),
    ).resolves.toBe("corp:user-42");

    await expect(
      resolveRequestSubject({ headers: { "x-embed-actor": "corp:user-42" } }, oidc, {
        NODE_ENV: "production",
        AUTH_MODE: "trusted_proxy",
      }),
    ).rejects.toBeInstanceOf(IdentityConfigurationError);
  });

  it("uses only the verified Bearer token in oidc_jwt mode", async () => {
    oidc.verify.mockClear();
    await expect(
      resolveRequestSubject(
        {
          headers: {
            authorization: "Bearer signed.jwt.value",
            "x-embed-actor": "spoofed:admin",
          },
        },
        oidc,
        { NODE_ENV: "production", AUTH_MODE: "oidc_jwt" },
      ),
    ).resolves.toBe("corp:user-42");
    expect(oidc.verify).toHaveBeenCalledWith("signed.jwt.value");

    await expect(
      resolveRequestSubject({ headers: { "x-embed-actor": "spoofed:admin" } }, oidc, {
        NODE_ENV: "production",
        AUTH_MODE: "oidc_jwt",
      }),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });
});
