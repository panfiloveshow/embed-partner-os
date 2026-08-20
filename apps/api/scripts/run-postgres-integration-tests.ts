/**
 * Runs the HTTP contract suite against a real PostgreSQL instance.
 *
 * The suite mutates data (append-only tables included), so it always starts
 * from a dedicated throwaway database: drop, create, migrate, seed, test.
 * The admin connection reuses DATABASE_URL (defaults to the local compose
 * instance); the test database lives on the same server under a `_it` suffix.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATABASE_URL =
  "postgresql://embed_os:embed_os@127.0.0.1:55432/embed_os?schema=public";

const adminUrl = new URL(process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL);
const baseName = adminUrl.pathname.replace(/^\//, "") || "embed_os";
const testDatabase = `${baseName}_it`;
const testUrl = new URL(adminUrl.toString());
testUrl.pathname = `/${testDatabase}`;
testUrl.searchParams.set("schema", "public");

async function recreateDatabase() {
  const prisma = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${testDatabase}"`);
  } finally {
    await prisma.$disconnect();
  }
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: apiRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      PERSISTENCE_MODE: "postgres",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await recreateDatabase();
run("npx", ["prisma", "migrate", "deploy"]);
run("npx", ["tsx", "prisma/seed.ts"]);
run("npx", ["vitest", "run", "src/app.integration.test.ts"]);
