import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  OnModuleInit,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import {
  AuthenticationRequiredError,
  IdentityConfigurationError,
  PublicRoute,
} from "./auth-base.js";
import { AccessAdministrationService } from "../access-administration.service.js";
import { PrismaService } from "../persistence/prisma.service.js";

/**
 * Встроенная аутентификация по логину/паролю для клиентов без внешнего SSO.
 *
 * Включается режимом AUTH_MODE_LOCAL_PASSWORD (см. ниже). Работает поверх тех
 * же учётных записей, что и SSO: у пользователя появляется необязательный
 * password_hash (scrypt), а сессией служит короткоживущий HS256 JWT,
 * который API сам же и проверяет. Внешние зависимости не нужны.
 */

/** Значение AUTH_MODE для входа по паролю. */
export const AUTH_MODE_LOCAL_PASSWORD = ["local", "password"].join("_");

/** Issuer/Audience локальных сессий. */
export const LOCAL_AUTH_ISSUER = ["embed-partner", "os"].join("-");
export const LOCAL_AUTH_AUDIENCE = LOCAL_AUTH_ISSUER;

/** Сессия живёт 12 часов, после чего нужен повторный вход. */
export const LOCAL_AUTH_TTL_SECONDS = 12 * 60 * 60;

const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_KEY_LENGTH = 64;

/** Хеширует пароль: scrypt со случайной солью, формат scrypt$salt$hash. */
export function hashPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new IdentityConfigurationError(
      `Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов`,
    );
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEY_LENGTH);
  return ["scrypt", salt.toString("base64"), derived.toString("base64")].join("$");
}

/** Проверка пароля против сохранённого хеша за постоянное время. */
export function verifyPassword(
  password: string,
  stored: string | null | undefined,
): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  try {
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(
      password.normalize("NFKC"),
      Buffer.from(saltB64, "base64"),
      expected.length,
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Секрет подписи локальных сессий; обязателен и не короче 32 символов. */
function localAuthSecret(): Uint8Array {
  const raw = process.env.LOCAL_AUTH_SECRET?.trim() ?? "";
  if (raw.length < 32) {
    throw new IdentityConfigurationError(
      "Для режима локального входа задайте LOCAL_AUTH_SECRET длиной не менее 32 символов",
    );
  }
  return new TextEncoder().encode(raw);
}

/** Проверяет Bearer-токен сессии и возвращает subject учётной записи. */
export async function verifyLocalSessionToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, localAuthSecret(), {
      issuer: LOCAL_AUTH_ISSUER,
      audience: LOCAL_AUTH_AUDIENCE,
    });
    const subject = payload.sub?.trim();
    if (!subject) throw new Error("пустой sub");
    return subject;
  } catch {
    throw new AuthenticationRequiredError("Сессия недействительна или истекла");
  }
}

/** Подписывает локальную сессию после успешного входа. */
export async function signLocalSessionToken(subject: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subject)
    .setIssuedAt()
    .setIssuer(LOCAL_AUTH_ISSUER)
    .setAudience(LOCAL_AUTH_AUDIENCE)
    .setExpirationTime(`${LOCAL_AUTH_TTL_SECONDS}s`)
    .sign(localAuthSecret());
}

export interface LocalCredentialsPort {
  verify(email: string, password: string): Promise<{ subject: string } | null>;
}

/** DI-токен реализации LocalCredentialsPort. */
export const LOCAL_CREDENTIALS = Symbol("LOCAL_CREDENTIALS");

/**
 * Проверка учётных данных в обоих режимах хранения: PostgreSQL-запрос по
 * email или реестр пользователей in-memory. Учётная запись должна быть
 * ACTIVE и иметь непустой password_hash.
 */
@Injectable()
export class LocalCredentialsService implements LocalCredentialsPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AccessAdministrationService)
    private readonly administration: AccessAdministrationService,
  ) {}

  async verify(email: string, password: string): Promise<{ subject: string } | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !password) return null;
    if (process.env.PERSISTENCE_MODE === "postgres") {
      const user = await this.prisma.user.findUnique({
        where: { email: normalized },
        select: { externalSubject: true, status: true, passwordHash: true },
      });
      if (!user || user.status !== "ACTIVE" || !user.passwordHash) return null;
      return verifyPassword(password, user.passwordHash)
        ? { subject: user.externalSubject }
        : null;
    }
    return this.administration.verifyLocalCredentials(normalized, password, verifyPassword);
  }
}

interface LoginAttempt {
  count: number;
  resetAt: number;
}
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_MS = 60_000;

@Controller("auth")
export class AuthController {
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(@Inject(LOCAL_CREDENTIALS) private readonly credentials: LocalCredentialsPort) {}

  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @Post("login")
  async login(
    @Body() body: unknown,
  ): Promise<{ accessToken: string; tokenType: "Bearer"; expiresInSeconds: number }> {
    const parsed = parseLoginCommand(body);
    this.enforceRateLimit(parsed.email);
    const matched = await this.credentials.verify(parsed.email, parsed.password);
    if (!matched) throw new UnauthorizedException("Неверный email или пароль");
    const accessToken = await signLocalSessionToken(matched.subject);
    return { accessToken, tokenType: "Bearer", expiresInSeconds: LOCAL_AUTH_TTL_SECONDS };
  }

  /** Защита от перебора: не более N попыток на email в скользящем окне. */
  private enforceRateLimit(email: string) {
    const now = Date.now();
    const current = this.attempts.get(email);
    if (!current || current.resetAt <= now) {
      this.attempts.set(email, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
      return;
    }
    current.count += 1;
    if (current.count > LOGIN_RATE_LIMIT) {
      throw new UnauthorizedException("Слишком много попыток входа; повторите позже");
    }
  }
}

function parseLoginCommand(body: unknown): { email: string; password: string } {
  if (typeof body !== "object" || body === null) {
    throw new UnauthorizedException("Неверный email или пароль");
  }
  const email = (body as { email?: unknown }).email;
  const password = (body as { password?: unknown }).password;
  if (typeof email !== "string" || typeof password !== "string") {
    throw new UnauthorizedException("Неверный email или пароль");
  }
  return { email: email.trim().toLowerCase(), password };
}

/**
 * Создаёт/обновляет администратора из переменных окружения на старте:
 * LOCAL_ADMIN_EMAIL + LOCAL_ADMIN_PASSWORD. Идемпотентно: существующая
 * учётная запись получает/обновляет password_hash без смены роли и прав.
 */
@Injectable()
export class LocalAdminBootstrapService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AccessAdministrationService)
    private readonly administration: AccessAdministrationService,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = process.env.LOCAL_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.LOCAL_ADMIN_PASSWORD ?? "";
    if (!email && !password) return;
    if (!email || !password) {
      throw new IdentityConfigurationError(
        "LOCAL_ADMIN_EMAIL и LOCAL_ADMIN_PASSWORD задаются вместе",
      );
    }
    const passwordHash = hashPassword(password);
    if (process.env.PERSISTENCE_MODE === "postgres") {
      await this.bootstrapPostgres(email, passwordHash);
      return;
    }
    this.administration.ensureLocalAdmin(email, passwordHash);
    console.log(JSON.stringify({ event: "local-auth.admin-ready", mode: "memory", email }));
  }

  private async bootstrapPostgres(email: string, passwordHash: string): Promise<void> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.passwordHash !== passwordHash) {
        await this.prisma.user.update({ where: { email }, data: { passwordHash } });
      }
    } else {
      await this.prisma.user.create({
        data: {
          id: randomUUID(),
          externalSubject: `local:${email}`,
          displayName: email.split("@")[0] || "Администратор",
          email,
          status: "ACTIVE",
          permissions: {
            create: [{ permission: "role:admin", source: "local-bootstrap" }],
          },
        },
      });
    }
    console.log(JSON.stringify({ event: "local-auth.admin-ready", mode: "postgres", email }));
  }
}
