// Reset a user's password directly in Postgres (local admin utility).
//
//   node scripts/reset-password.mjs <email> <new-password>
//
// Reads DB connection settings from backend/.env, bcrypt-hashes the new
// password with the same cost the app uses (10), and updates the profile row.
import pg from "pg";
import bcrypt from "bcrypt";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error("Usage: node scripts/reset-password.mjs <email> <new-password (8+ chars)>");
  process.exit(1);
}

// Minimal .env parse (CRLF-safe) — same approach as the app's config loading.
const env = {};
const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
for (let line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  line = line.trim();
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const pool = new pg.Pool({
  host: env.DB_HOST || "localhost",
  port: Number(env.DB_PORT) || 5432,
  user: env.DB_USERNAME || "postgres",
  password: env.DB_PASSWORD || "password",
  database: env.DB_NAME || "posting_pilot_db",
});

const hash = await bcrypt.hash(password, 10);
const { rows } = await pool.query(
  "update profiles set password_hash = $1 where lower(email) = lower($2) returning email, display_name, role",
  [hash, email],
);

if (!rows.length) {
  console.error(`No profile found for "${email}". Existing profiles:`);
  const { rows: all } = await pool.query("select email, role, status from profiles order by created_at");
  for (const p of all) console.error(`  - ${p.email} (${p.role}, ${p.status})`);
  process.exit(1);
}

console.log(`Password updated for ${rows[0].email} (${rows[0].display_name}, ${rows[0].role}).`);
process.exit(0);
