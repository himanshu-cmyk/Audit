/* eslint-env node */
// Creates a throwaway SQLite database from the project's real Prisma migrations.
import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";

const MIGRATIONS = path.resolve(__dirname, "../../prisma/migrations");

export async function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-audit-test-"));
  const file = path.join(dir, "test.sqlite");
  const db = new PrismaClient({ datasourceUrl: `file:${file.replace(/\\/g, "/")}` });
  const dirs = fs.readdirSync(MIGRATIONS).filter((d) => fs.statSync(path.join(MIGRATIONS, d)).isDirectory()).sort();
  for (const d of dirs) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, d, "migration.sql"), "utf8");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter((s) => s && !/^--[^\n]*$/.test(s))) {
      await db.$executeRawUnsafe(stmt);
    }
  }
  return {
    db,
    async cleanup() {
      await db.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
