import { Logger } from "@nestjs/common";

// Fail fast on a misconfigured deploy.
//
// Without this, missing/placeholder config doesn't surface until the first
// request, and then only as an opaque 500 ("Invalid supabaseUrl: Provided URL
// is malformed") on EVERY authenticated route — which looks like an app bug
// rather than a config mistake. Checking at boot turns that into one obvious
// error before the process starts serving traffic.

// Values copied from .env.example that were never filled in.
function isPlaceholder(value: string) {
  return /^<.*>$/.test(value.trim()) || value.includes("<project>") || value.includes("<your");
}

function isValidHttpsUrl(value: string) {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && !value.includes("<");
  } catch {
    return false;
  }
}

// Required to serve any authenticated request at all.
const REQUIRED = [
  { key: "SUPABASE_URL", url: true, alt: "NEXT_PUBLIC_SUPABASE_URL" },
  { key: "SUPABASE_SERVICE_ROLE_KEY" },
  { key: "SUPABASE_ANON_KEY", alt: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" },
];

// Not fatal — the app runs, but the related feature is unavailable.
const OPTIONAL = [
  { key: "FACEBOOK_CLIENT_ID", feature: "Facebook/Instagram publishing" },
  { key: "FACEBOOK_CLIENT_SECRET", feature: "Facebook/Instagram publishing" },
  { key: "THREADS_APP_ID", feature: "Threads publishing" },
  { key: "THREADS_APP_SECRET", feature: "Threads publishing" },
  { key: "X_CLIENT_ID", feature: "X (Twitter) publishing" },
  { key: "X_CLIENT_SECRET", feature: "X (Twitter) publishing" },
  { key: "GOOGLE_CLIENT_ID", feature: "YouTube publishing" },
  { key: "GOOGLE_CLIENT_SECRET", feature: "YouTube publishing" },
  { key: "CRON_SECRET", feature: "scheduled publishing + sync crons" },
];

export function verifyConfig() {
  const logger = new Logger("Config");
  const fatal: string[] = [];

  for (const { key, url, alt } of REQUIRED) {
    const value = process.env[key] || (alt ? process.env[alt] : "") || "";
    if (!value.trim()) {
      fatal.push(`${key} is missing`);
    } else if (isPlaceholder(value)) {
      fatal.push(`${key} is still the .env.example placeholder`);
    } else if (url && !isValidHttpsUrl(value)) {
      fatal.push(`${key} is not a valid URL ("${value}")`);
    }
  }

  const disabled = new Set<string>();
  for (const { key, feature } of OPTIONAL) {
    const value = process.env[key] || "";
    if (!value.trim() || isPlaceholder(value)) disabled.add(feature);
  }

  if (fatal.length) {
    logger.error("Refusing to start — required configuration is invalid:");
    fatal.forEach((f) => logger.error(`  • ${f}`));
    logger.error("Fix these in backend/.env (see .env.example), then restart.");
    process.exit(1);
  }

  if (disabled.size) {
    logger.warn(`Unconfigured — these features are disabled: ${[...disabled].join(", ")}`);
  }

  if ((process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase() !== "live") {
    logger.warn('FACEBOOK_PUBLISH_MODE is not "live" — posts are MOCKED, nothing reaches the platforms.');
  }
}
