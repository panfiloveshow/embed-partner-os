export interface MutationKeyState {
  hash: string;
  key: string;
}

export function createIdempotencyKey(prefix = "web"): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Возвращает идемпотентный ключ, привязанный к содержимому команды.
 * Пока payload (и scope) не меняются, повторные отправки используют тот же ключ,
 * поэтому ретрай после потерянного ответа не создаёт дубликат на сервере.
 * Изменённая форма даёт новый hash и, значит, новый ключ.
 */
export function mutationKey(
  ref: { current: MutationKeyState | null },
  payload: unknown,
  scope = "",
): string {
  const hash = `${scope}:${JSON.stringify(payload)}`;
  if (ref.current?.hash !== hash) {
    ref.current = { hash, key: createIdempotencyKey(scope || "web") };
  }
  return ref.current.key;
}
