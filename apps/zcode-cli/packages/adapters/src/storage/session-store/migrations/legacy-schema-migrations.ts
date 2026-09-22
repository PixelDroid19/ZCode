import { LEGACY_FOUNDATION_SQLITE_MIGRATIONS } from "./legacy-foundation-migrations.js";
import { LEGACY_INPUT_SQLITE_MIGRATIONS } from "./legacy-input-migrations.js";
import { LEGACY_USAGE_SQLITE_MIGRATIONS } from "./legacy-usage-migrations.js";

export type { SqliteMigration } from "./legacy-foundation-migrations.js";

export const LEGACY_SQLITE_MIGRATIONS = [
  ...LEGACY_FOUNDATION_SQLITE_MIGRATIONS,
  ...LEGACY_USAGE_SQLITE_MIGRATIONS,
  ...LEGACY_INPUT_SQLITE_MIGRATIONS,
] as const;
