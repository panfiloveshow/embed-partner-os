import { describe, expect, it } from "vitest";
import {
  BlockedNetworkTargetError,
  SafeHttpClient,
  createPinnedLookup,
  isPublicIpAddress,
  type SafeHttpRequester,
} from "./safe-http-client.js";

describe("crawler network safety", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("validates DNS again for every redirect and never requests a private target", async () => {
    const requested: string[] = [];
    const requester: SafeHttpRequester = async ({ url }) => {
      requested.push(url.toString());
      return {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
        body: Buffer.alloc(0),
      };
    };
    const client = new SafeHttpClient(
      async (hostname) =>
        hostname === "partner.example" ? ["93.184.216.34"] : ["169.254.169.254"],
      requester,
    );

    await expect(client.get("https://partner.example/video")).rejects.toBeInstanceOf(
      BlockedNetworkTargetError,
    );
    expect(requested).toEqual(["https://partner.example/video"]);
  });

  it("rejects credentials and non-HTTP protocols before DNS", async () => {
    const client = new SafeHttpClient(
      async () => ["93.184.216.34"],
      async () => {
        throw new Error("must not request");
      },
    );

    await expect(client.get("file:///etc/passwd")).rejects.toBeInstanceOf(
      BlockedNetworkTargetError,
    );
    await expect(client.get("https://user:secret@example.com/")).rejects.toBeInstanceOf(
      BlockedNetworkTargetError,
    );
    await expect(client.get("http://[::1]/admin")).rejects.toBeInstanceOf(
      BlockedNetworkTargetError,
    );
  });

  it("pins the validated address for both single and all-address Node lookups", async () => {
    const lookup = createPinnedLookup("93.184.216.34", 4);

    await expect(
      new Promise((resolve, reject) =>
        lookup("partner.example", { all: false }, (error, address, family) =>
          error ? reject(error) : resolve({ address, family }),
        ),
      ),
    ).resolves.toEqual({ address: "93.184.216.34", family: 4 });

    await expect(
      new Promise((resolve, reject) =>
        lookup("partner.example", { all: true }, (error, addresses) =>
          error ? reject(error) : resolve(addresses),
        ),
      ),
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
