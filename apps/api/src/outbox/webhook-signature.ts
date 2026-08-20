import { createHmac } from "node:crypto";

export interface SignedWebhookHeaders {
  "Idempotency-Key": string;
  "X-Embed-Message-Id": string;
  "X-Embed-Timestamp": string;
  "X-Embed-Signature": string;
}

export function signedWebhookHeaders(
  messageId: string,
  body: string,
  secret: string,
  now: Date = new Date(),
): SignedWebhookHeaders {
  const normalizedSecret = secret.trim();
  if (normalizedSecret.length < 32) {
    throw new Error("Webhook signing secret must contain at least 32 characters");
  }
  if (!messageId.trim()) throw new Error("Webhook message id is required");
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const signature = createHmac("sha256", normalizedSecret)
    .update(`${timestamp}.${messageId}.${body}`)
    .digest("hex");
  return {
    "Idempotency-Key": messageId,
    "X-Embed-Message-Id": messageId,
    "X-Embed-Timestamp": timestamp,
    "X-Embed-Signature": `sha256=${signature}`,
  };
}
