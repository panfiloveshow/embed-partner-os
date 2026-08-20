import { describe, expect, it, vi } from "vitest";
import { bridgeTokenProvider, webAuthenticationMode } from "./auth-bridge";

describe("web authentication bridge", () => {
  it("defaults to external auth only for a production build", () => {
    expect(webAuthenticationMode(undefined, false)).toBe("development");
    expect(webAuthenticationMode(undefined, true)).toBe("external");
    expect(() => webAuthenticationMode("unknown", true)).toThrow(/VITE_AUTH_MODE/u);
  });

  it("forwards a forced refresh to the corporate bridge", async () => {
    const getAccessToken = vi.fn(async () => "renewed.jwt.value");
    const provider = bridgeTokenProvider({ getAccessToken });

    await expect(provider.getAccessToken({ forceRefresh: true })).resolves.toBe(
      "renewed.jwt.value",
    );
    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  });
});
