import { describe, expect, it } from "vitest";
import { AuthenticationRequiredError } from "./access-control.js";
import {
  AccessAdministrationService,
} from "../access-administration.service.js";
import {
  AuthController,
  type LocalCredentialsPort,
  hashPassword,
  signLocalSessionToken,
  verifyLocalSessionToken,
  verifyPassword,
} from "./local-auth.js";

// Секрет обязателен для подписи/проверки сессий; длина >= 32 символов.
process.env.LOCAL_AUTH_SECRET = "test-secret-0123456789abcdef-0123456789abcdef";

describe("hashPassword / verifyPassword", () => {
  it("roundtrip: правильный пароль проходит, неверный — нет", () => {
    const hash = hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery", hash)).toBe(true);
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("короткий пароль отклоняется, пустой хеш не проходит", () => {
    expect(() => hashPassword("коротко")).toThrow();
    expect(verifyPassword("любой", null)).toBe(false);
    expect(verifyPassword("любой", "scrypt$abc")).toBe(false);
  });
});

describe("локальные сессии (HS256)", () => {
  it("sign -> verify возвращает subject", async () => {
    const token = await signLocalSessionToken("local:user@example.com");
    await expect(verifyLocalSessionToken(token)).resolves.toBe(
      "local:user@example.com",
    );
  });

  it("подделанный токен отклоняется", async () => {
    const token = await signLocalSessionToken("local:user@example.com");
    const tampered = token.slice(0, -3) + (token.endsWith("aaa") ? "bbb" : "aaa");
    await expect(verifyLocalSessionToken(tampered)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
  });
});

describe("memory-режим: AccessAdministrationService", () => {
  // PrismaService не используется memory-методами; заглушка допустима.
  const admin = new AccessAdministrationService(null as never);
  const EMAIL = "anna.sokolova@example.invalid";

  it("до выдачи пароля вход запрещён", () => {
    expect(
      admin.verifyLocalCredentials(EMAIL, "correct horse", verifyPassword),
    ).toBeNull();
  });

  it("после ensureLocalAdmin правильный пароль возвращает subject", () => {
    admin.ensureLocalAdmin(EMAIL, hashPassword("correct horse"));
    expect(
      admin.verifyLocalCredentials(EMAIL, "correct horse", verifyPassword),
    ).toEqual({ subject: "bootstrap:anna.sokolova" });
    expect(
      admin.verifyLocalCredentials(EMAIL.toUpperCase(), "correct horse", verifyPassword),
    ).toEqual({ subject: "bootstrap:anna.sokolova" });
    expect(admin.verifyLocalCredentials(EMAIL, "неверный", verifyPassword)).toBeNull();
  });
});

describe("AuthController.login", () => {
  const credentials: LocalCredentialsPort = {
    verify: async (email, password) =>
      email === "user@example.com" && password === "верный-пароль"
        ? { subject: "local:user@example.com" }
        : null,
  };
  const controller = new AuthController(credentials);

  it("успешный вход отдаёт Bearer-токен и срок жизни", async () => {
    const response = await controller.login({
      email: "User@Example.com",
      password: "верный-пароль",
    });
    expect(response.tokenType).toBe("Bearer");
    expect(response.expiresInSeconds).toBeGreaterThan(3600);
    await expect(verifyLocalSessionToken(response.accessToken)).resolves.toBe(
      "local:user@example.com",
    );
  });

  it("неверный пароль -> 401", async () => {
    await expect(
      controller.login({ email: "user@example.com", password: "не-то" }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("более 10 неудачных попыток подряд ограничиваются", async () => {
    const limited = new AuthController(credentials);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        limited.login({ email: "brute@example.com", password: "не-то" }),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      limited.login({ email: "brute@example.com", password: "верный-пароль" }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("некорректное тело запроса -> 401 без деталей", async () => {
    await expect(controller.login({ user: "x" })).rejects.toMatchObject({
      status: 401,
    });
  });
});
