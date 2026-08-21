import { Logger } from "@nestjs/common";

// Fail fast on a misconfigured deploy: missing or placeholder config surfaces
// as one clear boot error instead of a 500 on every request.

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

// Required to serve any request at all — the Postgres connection + JWT signing.
const REQUIRED: { key: string; url?: boolean; alt?: string }[] = [
  { key: "DB_HOST" },
  { key: "DB_USERNAME" },
  { key: "DB_PASSWORD" },
  { key: "DB_NAME" },
  { key: "JWT_SECRET" },
];

// Not fatal — the app runs, but the related feature is unavailable.
const OPTIONAL = [
  { key: "FACEBOOK_CLIENT_ID", feature: "Facebook/Instagram publishing" },
  { key: "FACEBOOK_CLIENT_SECRET", feature: "Facebook/Instagram publishing" },
  // Threads and personal/standalone Instagram publish through Postiz, which
  // holds those platform tokens — one workspace key covers every such channel.
  { key: "POSTIZ_API_KEY", feature: "Threads + standalone Instagram publishing (via Postiz)" },
  { key: "X_CLIENT_ID", feature: "X (Twitter) publishing" },
  { key: "X_CLIENT_SECRET", feature: "X (Twitter) publishing" },
  { key: "GOOGLE_CLIENT_ID", feature: "YouTube publishing" },
  { key: "GOOGLE_CLIENT_SECRET", feature: "YouTube publishing" },
  { key: "CRON_SECRET", feature: "scheduled publishing + sync crons" },
  { key: "S3_BUCKET", feature: "media uploads" },
  { key: "AWS_REGION", feature: "media uploads" },
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
