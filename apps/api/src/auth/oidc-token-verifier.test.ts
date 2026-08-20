import { describe, expect, it } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import {
  OidcConfigurationError,
  OidcJwtVerifier,
  OidcTokenVerificationError,
  oidcConfigFromEnvironment,
} from "./oidc-token-verifier.js";

describe("OIDC JWT verifier", () => {
  it("verifies signature, issuer, audience, expiry and returns subject", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const verifier = new OidcJwtVerifier(
      {
        issuer: "https://identity.example.test/",
        audience: ["embed-partner-os"],
        jwksUrl: "https://identity.example.test/jwks",
        algorithms: ["RS256"],
        timeoutMs: 1_000,
      },
      createLocalJWKSet({ keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }] }),
    );
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer("https://identity.example.test/")
      .setAudience("embed-partner-os")
      .setSubject("corp:user-123")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

    await expect(verifier.verify(token)).resolves.toBe("corp:user-123");
  });

  it("rejects a token with another audience or an expired token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const verifier = new OidcJwtVerifier(
      {
        issuer: "https://identity.example.test/",
        audience: ["embed-partner-os"],
        jwksUrl: "https://identity.example.test/jwks",
        algorithms: ["RS256"],
        timeoutMs: 1_000,
      },
      createLocalJWKSet({ keys: [{ ...publicJwk, kid: "key-1", alg: "RS256" }] }),
    );
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer("https://identity.example.test/")
      .setAudience("another-api")
      .setSubject("corp:user-123")
      .setIssuedAt(now - 600)
      .setExpirationTime(now - 300)
      .sign(privateKey);

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(OidcTokenVerificationError);
  });

  it("rejects insecure JWKS configuration and symmetric algorithms", () => {
    expect(() => oidcConfigFromEnvironment({
      OIDC_ISSUER: "https://identity.example.test/",
      OIDC_AUDIENCE: "embed-partner-os",
      OIDC_JWKS_URL: "http://identity.example.test/jwks",
    })).toThrow(OidcConfigurationError);
    expect(() => oidcConfigFromEnvironment({
      OIDC_ISSUER: "https://identity.example.test/",
      OIDC_AUDIENCE: "embed-partner-os",
      OIDC_JWKS_URL: "https://identity.example.test/jwks",
      OIDC_ALLOWED_ALGORITHMS: "HS256",
    })).toThrow("поддерживает только");
  });
});
