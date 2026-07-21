// ─────────────────────────────────────────────────────────────────────────
//  FREE / LOCAL content assistant — deterministic helpers, no API, no cost.
//  Same function surface a real LLM would fill. When an OPENAI/ANTHROPIC key
//  is added later, /api/ai routes to the model; until then these run.
// ─────────────────────────────────────────────────────────────────────────

const SPORT_EMOJI = {
  NFL: "🏈", NBA: "🏀", MLB: "⚾", NHL: "🏒", "MMA/UFC": "🥊", Boxing: "🥊",
  Golf: "⛳", Soccer: "⚽", Motorsport: "🏎️", Tennis: "🎾", WWE: "🤼",
  College: "🎓", Cricket: "🏏", Other: "🔥"
};

const STOP = new Set(
  "the a an and or but of to in on for with at by from is are was were be been this that it as your you we our have has will just about into over after".split(" ")
);

export function grammarTidy(text = "") {
  let t = text.replace(/\s+/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  if (t && !/[.!?"]$/.test(t)) t += ".";
  return t;
}

export function generateHashtags(text = "", sport = "Other", max = 6) {
  const words = (text.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOP.has(w));
  const freq = {};
  words.forEach((w) => (freq[w] = (freq[w] || 0) + 1));
  const top = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, max - 2);
  const base = [sport.replace(/[^a-zA-Z]/g, ""), "Sports"];
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  return [...new Set([...base, ...top.map(cap)])].filter(Boolean).slice(0, max).map((w) => "#" + w);
}

export function generateEmojis(sport = "Other") {
  const e = SPORT_EMOJI[sport] || "🔥";
  return [...new Set([e, "🔥", "💯", "🙌", "👀", "🚨"])].slice(0, 6);
}

export function generateCTA() {
  return [
    "👉 Drop your thoughts below.",
    "What do you think? 🤔",
    "Tag someone who needs to see this.",
    "Follow for more 🔔",
    "Agree or disagree? 👇"
  ];
}

export function toneRewrite(text = "", tone = "professional", sport = "Other") {
  const clean = grammarTidy(text);
  const e = SPORT_EMOJI[sport] || "🔥";
  switch (tone) {
    case "exciting":  return `${e} ${clean} 🚨🔥`;
    case "funny":     return `${clean} 😂 You can't make this up.`;
    case "breaking":  return `🚨 BREAKING: ${clean}`;
    case "minimal":   return clean.replace(/[🚨🔥💯🙌👀]/g, "").replace(/\s+/g, " ").trim();
    default:          return clean; // professional
  }
}

export function variations(text = "", sport = "Other") {
  const c = grammarTidy(text);
  const e = SPORT_EMOJI[sport] || "🔥";
  return [c, `${e} ${c}`, `${c}\n\n${generateCTA()[0]}`];
}

// Central dispatch used by the /api/ai route.
export function runAi({ action, text = "", sport = "Other", tone = "professional" }) {
  switch (action) {
    case "hashtags":   return { result: generateHashtags(text, sport).join(" ") };
    case "emojis":     return { result: generateEmojis(sport).join(" ") };
    case "cta":        return { results: generateCTA() };
    case "grammar":    return { result: grammarTidy(text) };
    case "tone":       return { result: toneRewrite(text, tone, sport) };
    case "variations": return { results: variations(text, sport) };
    default:           return { error: "Unknown AI action." };
  }
}
