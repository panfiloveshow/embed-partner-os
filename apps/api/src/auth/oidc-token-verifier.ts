import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

export const OIDC_TOKEN_VERIFIER = Symbol("OIDC_TOKEN_VERIFIER");

const ALLOWED_ALGORITHMS = ["RS256", "PS256", "ES256"] as const;
type AllowedAlgorithm = (typeof ALLOWED_ALGORITHMS)[number];

export interface OidcTokenVerifierPort {
  verify(token: string): Promise<string>;
}

export interface OidcVerifierConfig {
  issuer: string;
  audience: string[];
  jwksUrl: string;
  algorithms: AllowedAlgorithm[];
  timeoutMs: number;
}

export class OidcTokenVerificationError extends Error {
  constructor(message = "OIDC access token недействителен или истёк") {
    super(message);
    this.name = "OidcTokenVerificationError";
  }
}

export class OidcConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigurationError";
  }
}

export class OidcJwtVerifier implements OidcTokenVerifierPort {
  private readonly key: JWTVerifyGetKey;

  constructor(
    private readonly config: OidcVerifierConfig,
    key?: JWTVerifyGetKey,
  ) {
    this.key = key ?? createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: config.timeoutMs,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  async verify(token: string): Promise<string> {
    if (!token || token.length > 16_384) throw new OidcTokenVerificationError();
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== "string") throw new OidcTokenVerificationError();
      return validateSubject(payload.sub);
    } catch (error) {
      if (error instanceof OidcTokenVerificationError) throw error;
      throw new OidcTokenVerificationError();
    }
  }
}

export class EnvironmentOidcTokenVerifier implements OidcTokenVerifierPort {
  private verifier: OidcJwtVerifier | null = null;

  verify(token: string): Promise<string> {
    this.verifier ??= new OidcJwtVerifier(oidcConfigFromEnvironment());
    return this.verifier.verify(token);
  }
}

export function oidcConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): OidcVerifierConfig {
  const issuer = requiredSetting(environment.OIDC_ISSUER, "OIDC_ISSUER", 500);
  const jwksUrl = secureUrl(requiredSetting(environment.OIDC_JWKS_URL, "OIDC_JWKS_URL", 2_000));
  const audience = listSetting(environment.OIDC_AUDIENCE, "OIDC_AUDIENCE", 10);
  const requestedAlgorithms = environment.OIDC_ALLOWED_ALGORITHMS?.trim()
    ? listSetting(environment.OIDC_ALLOWED_ALGORITHMS, "OIDC_ALLOWED_ALGORITHMS", 3)
    : ["RS256"];
  const algorithms = requestedAlgorithms.map((algorithm) => {
    if (!ALLOWED_ALGORITHMS.some((allowed) => allowed === algorithm)) {
      throw new OidcConfigurationError(
        `OIDC_ALLOWED_ALGORITHMS поддерживает только ${ALLOWED_ALGORITHMS.join(", ")}`,
      );
    }
    return algorithm as AllowedAlgorithm;
  });
  return {
    issuer,
    audience,
    jwksUrl,
    algorithms,
    timeoutMs: integerSetting(environment.OIDC_JWKS_TIMEOUT_MS, 5_000, 100, 30_000),
  };
}

function requiredSetting(value: string | undefined, name: string, maxLength: number) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new OidcConfigurationError(`${name} обязателен и не должен превышать ${maxLength} символов`);
  }
  return normalized;
}

function listSetting(value: string | undefined, name: string, maxItems: number) {
  const items = [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  if (items.length === 0 || items.length > maxItems) {
    throw new OidcConfigurationError(`${name} должен содержать от 1 до ${maxItems} значений`);
  }
  return items;
}

function secureUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcConfigurationError("OIDC_JWKS_URL должен быть абсолютным HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new OidcConfigurationError(
      "OIDC_JWKS_URL должен быть HTTPS URL без credentials и fragment",
    );
  }
  return url.toString();
}

function integerSetting(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new OidcConfigurationError(
      `OIDC_JWKS_TIMEOUT_MS должен быть целым числом от ${minimum} до ${maximum}`,
    );
  }
  return value;
}

function validateSubject(subject: string) {
  const normalized = subject.trim();
  if (!/^[a-zA-Z0-9._:@/-]{3,200}$/.test(normalized)) {
    throw new OidcTokenVerificationError("OIDC subject имеет недопустимый формат");
  }
  return normalized;
}
