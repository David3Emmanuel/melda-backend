import 'dotenv/config';
import path from 'node:path';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migrateNode } from 'drizzle-orm/node-postgres/migrator';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import * as schema from './schema';

// One schema, two drivers. PGlite (Postgres compiled to WASM, in-process) is the
// zero-setup default so a judge can clone and run with no Docker and no external
// database. Setting DATABASE_URL swaps in a real Postgres over `pg` - same schema,
// same SQL, only the connection bootstrap differs. Checks set
// PGLITE_DIR=memory:// before importing this module to get an isolated DB.
const url = process.env.DATABASE_URL;
export const usingPglite = !url;

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'drizzle');

// The two adapters are structurally identical for the query surface we use, so we
// expose a single node-postgres-typed handle. The cast on the PGlite branch is the
// one deliberate shortcut; each migrator still receives its correctly-typed driver.
let dbHandle: NodePgDatabase<typeof schema>;
let migrateHandle: () => Promise<void>;

if (usingPglite) {
  const client = new PGlite(process.env.PGLITE_DIR || '.melda-pglite');
  const d = drizzlePglite(client, { schema });
  dbHandle = d as unknown as NodePgDatabase<typeof schema>;
  migrateHandle = () => migratePglite(d, { migrationsFolder: MIGRATIONS_DIR });
} else {
  const pool = new Pool({ connectionString: url });
  const d = drizzleNode(pool, { schema });
  dbHandle = d;
  migrateHandle = () => migrateNode(d, { migrationsFolder: MIGRATIONS_DIR });
}

export const db = dbHandle;
export const migrateDb = migrateHandle;
