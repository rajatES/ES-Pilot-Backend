// Selective fact-check gate for the approval chokepoint. Ported from the
// es-page-registry design: triage → Grok (via an OpenAI-style AI gateway) →
// pass / flag / block. Fully env-gated and FAIL-OPEN — with no key it is a
// pure no-op, and any error/timeout returns "pass" so it can never block the
// pipeline.

const KEY = () => process.env.AI_GATEWAY_API_KEY || process.env.GROK_API_KEY || process.env.XAI_API_KEY || "";
const BASE_URL = () => process.env.GROK_BASE_URL || "https://ai-gateway.vercel.sh/v1";
const MODEL = () => process.env.GROK_MODEL || "xai/grok-4.1-fast-reasoning";
const TIMEOUT_MS = 25_000;
const FALSE_CONF_MIN = Number(process.env.FACTCHECK_FALSE_CONF_MIN || 0.7);

// off | shadow | enforce. No key ⇒ off. With a key, defaults to enforce.
export function factCheckMode() {
  if (!KEY()) return "off";
  const m = (process.env.FACTCHECK_MODE || "enforce").trim().toLowerCase();
  return ["off", "shadow", "enforce"].includes(m) ? m : "enforce";
}

export function factCheckEnabled() {
  return factCheckMode() !== "off";
}

// Cheap regex triage — only text making a checkable, volatile factual claim is
// worth a Grok call. Opinion/questions/hype skip entirely.
function hasCheckableClaim(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return { checkable: false, reason: "empty" };
  if (/[?]\s*$/.test(t.trim()) && t.length < 120) return { checkable: false, reason: "question" };
  const patterns = [
    /\b(first|only|last|fastest|slowest|most|least|best|worst|record|all-time|ever)\b/, // superlative
    /\b\d{4}\b/, // a year
    /\b\d+(\.\d+)?\s*(points|goals|wins|losses|titles|championships|yards|runs|games|seconds|mph|kg|lbs)\b/, // stat
    /\b(won|beat|defeated|signed|traded|retired|died|passed away|announced|confirmed|breaks?|broke|set|became)\b/, // outcome/news
    /\b(today|yesterday|tonight|this (week|season|year)|on this day)\b/, // recency
  ];
  const hit = patterns.some((re) => re.test(t));
  return { checkable: hit, reason: hit ? "checkable-claim" : "no-checkable-claim" };
}

function passRecord(reason, extra = {}) {
  return { action: "pass", reason, verdict: null, checked: false, mode: factCheckMode(), at: new Date().toISOString(), ...extra };
}

async function callGrok(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL()}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY()}` },
      body: JSON.stringify({
        model: MODEL(),
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You fact-check short social-media sports captions. Judge only concrete, checkable claims. " +
              "If you cannot confirm a claim from your knowledge, return verdict \"uncertain\" (NOT \"false\"). " +
              'Reply with STRICT JSON only: {"verdict":"true|false|uncertain","false_claim_confidence":0-1,"reason":"short"}.',
          },
          { role: "user", content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content || "";
    content = content.replace(/```json|```/g, "").trim();
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no json in verdict");
    return JSON.parse(match[0]);
  } finally {
    clearTimeout(timer);
  }
}

// Returns a fact-check record. Never throws.
export async function factCheckCaption({ headline = "", caption = "" } = {}) {
  const mode = factCheckMode();
  if (mode === "off") return passRecord("disabled");

  const text = [headline, caption].filter(Boolean).join("\n").trim();
  const triage = hasCheckableClaim(text);
  if (!triage.checkable) return passRecord(triage.reason);

  try {
    const v = await callGrok(text);
    const verdict = String(v?.verdict || "uncertain").toLowerCase();
    const conf = Number(v?.false_claim_confidence || 0);
    const reason = String(v?.reason || "").slice(0, 300);
    const at = new Date().toISOString();

    if (verdict === "false" && conf >= FALSE_CONF_MIN) {
      return { action: "block", reason: reason || "Likely false claim.", verdict, checked: true, mode, at };
    }
    if (verdict === "uncertain") {
      if ((process.env.FACTCHECK_ON_UNCERTAIN || "").toLowerCase() === "pass") return passRecord("uncertain-pass", { verdict, checked: true });
      return { action: "flag", reason: reason || "Couldn't verify a claim — needs a human.", verdict, checked: true, mode, at };
    }
    return { action: "pass", reason: reason || "verified", verdict, checked: true, mode, at };
  } catch (e) {
    // Fail-open: never let a gateway hiccup block a post.
    return passRecord(`grok-error(fail-open): ${e.message}`);
  }
}
