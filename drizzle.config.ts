import type { Config } from 'drizzle-kit';

// drizzle-kit only needs the schema + dialect to *generate* SQL migrations; the
// runtime migrator (src/db/migrate) applies them against whichever driver is live.
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
} satisfies Config;
