// ─────────────────────────────────────────────────────────────────────────
//  FB / IG CONTENT PRE-PUBLISH COMPLIANCE CHECK
//  Encodes: EssentiallySports Editorial & Social Risk Rubric v2.0 (July 2026)
//
//  The rubric is a HUMAN-REVIEW AID, not an automated gate. So this module
//  splits into two parts:
//    1. RULES        — automatically detectable from caption/link/image/platform
//    2. MANUAL_CHECKS — HIGH-risk items that need human eyes before every post
//
//  Severity: "HIGH" (do not publish), "MED" (fix if possible), "LOW" (note).
//  Mode is warn + require confirm — nothing is hard-blocked, but HIGH flags
//  are shown prominently and the user must explicitly confirm.
//
//  ctx = { body, linkUrl, imageUrl, accounts: [{display_name, category, platform}] }
// ─────────────────────────────────────────────────────────────────────────

const has = (body, re) => re.test(body || "");

export const RULES = [
  // ── Universal ──
  {
    id: "not-empty", section: "Universal", severity: "HIGH",
    label: "Caption is not empty", policy: "Basic",
    test: (c) => !c.body?.trim(),
    message: "Post has no text."
  },
  {
    id: "max-length", section: "Universal", severity: "HIGH",
    label: "Within 5,000 characters", policy: "Facebook limit",
    test: (c) => (c.body?.length || 0) > 5000,
    message: "Caption exceeds Facebook's 5,000-character limit."
  },
  {
    id: "engagement-bait", section: "Universal", severity: "MED",
    label: "No engagement-bait prompts", policy: "Spam / Engagement Bait (2026 model)",
    test: (c) => has(c.body, /\b(tag \d+|tag your|tag a friend|comment ["“'`]?\w+["”'`]? (for|to)|comment below (for|to)|share to (win|enter)|like (and|&) share|vote (for|below)|double tap|react to)\b/i),
    message: "Contains a transactional engagement prompt (tag/comment-for-link/share-to-win). 2026 classifier hard-caps these at seed audience."
  },
  {
    id: "restricted-goods", section: "Universal", severity: "MED",
    label: "No unqualified restricted-goods refs", policy: "Restricted Goods; Advertising Standards",
    test: (c) => has(c.body, /\b(sportsbook|draftkings|fanduel|\bdfs\b|casino|gambl\w*|parlay|betting odds|beer|whiskey|vodka|tobacco|vape|\bcbd\b|\bthc\b)\b/i),
    message: "Mentions gambling/alcohol/tobacco/CBD — needs disclaimers or age-gating context."
  },
  {
    id: "gambling-language", section: "Universal", severity: "MED",
    label: "No guaranteed-outcome betting language", policy: "Restricted Goods",
    test: (c) => has(c.body, /\block of the day\b|guaranteed (win|lock|money)|sure thing|can'?t lose/i),
    message: "Implied guaranteed betting outcome ('lock of the day', 'guaranteed win')."
  },
  {
    id: "misinfo-framing", section: "Universal", severity: "LOW",
    label: "Unverified claims are attributed", policy: "Misinformation",
    test: (c) => has(c.body, /\b(reportedly|rumou?r|unconfirmed|allegedly|sources say|breaking)\b/i),
    message: "Contains unverified/breaking framing — make sure it's sourced and not stated as fact."
  },
  {
    id: "sexualized", section: "Universal", severity: "MED",
    label: "Not sexualized framing", policy: "Adult Nudity & Sexual Activity",
    test: (c) => has(c.body, /\b(bikini|swimsuit|wardrobe malfunction|thirst trap|lingerie|racy)\b/i),
    message: "Caption may sexualize the subject — review imagery/crop and framing."
  },

  // ── Text & Caption ──
  {
    id: "gibberish-caption", section: "Text", severity: "HIGH",
    label: "Caption reads as real text", policy: "Basic",
    test: (c) => {
      const words = (c.body || "").trim().split(/\s+/).filter((w) => /^[a-zA-Z]+$/.test(w) && w.length >= 5);
      if (words.length < 2) return false;
      const gibberish = words.filter(looksLikeGibberishWord).length;
      return gibberish / words.length >= 0.5;
    },
    message: "Caption reads as random/gibberish text rather than real words — rewrite before publishing."
  },
  {
    id: "clickbait", section: "Text", severity: "MED",
    label: "No clickbait mismatch framing", policy: "Misinformation; Recommendations",
    test: (c) => has(c.body, /you won'?t believe|won'?t believe|shocking|wait (un)?til you see|this is why|number \d+ will|will shock you|jaw-dropping/i),
    message: "Classic clickbait framing — caption must match what the linked content supports."
  },
  {
    id: "health-claims", section: "Text", severity: "MED",
    label: "No unsourced health/medical claims", policy: "Restricted Health Content",
    test: (c) => has(c.body, /\b(cure|miracle|detox|guaranteed recovery|supplement|weight loss|fat burner|boost testosterone)\b/i),
    message: "Health/recovery/supplement claim — needs sourcing or it risks a restricted-content flag."
  },

  // ── Distribution hygiene ──
  {
    id: "excessive-hashtags", section: "Universal", severity: "LOW",
    label: "≤ 5 hashtags", policy: "Recommendations Guidelines",
    test: (c) => ((c.body || "").match(/#\w+/g) || []).length > 5,
    message: "More than 5 hashtags can reduce organic distribution."
  },
  {
    id: "all-caps", section: "Universal", severity: "LOW",
    label: "Not all-caps", policy: "Spam signals",
    test: (c) => {
      const letters = (c.body || "").replace(/[^a-zA-Z]/g, "");
      return letters.length > 15 && letters === letters.toUpperCase();
    },
    message: "Caption is entirely uppercase — reads as shouting / spammy."
  },
  {
    id: "link-https", section: "Universal", severity: "LOW",
    label: "Link uses https", policy: "Link safety",
    test: (c) => !!c.linkUrl && !/^https:\/\//i.test(c.linkUrl),
    message: "Link is not https — use a secure URL."
  },

  // ── Image / platform ──
  {
    id: "requires-image", section: "Image", severity: "HIGH",
    label: "Post has an image or image link", policy: "Basic",
    test: (c) => !c.imageUrl,
    message: "No image or image link attached — every post needs one before it can be scheduled."
  },
  {
    id: "requires-content-type", section: "Universal", severity: "HIGH",
    label: "Content type is set", policy: "Basic",
    test: (c) => !c.contentType,
    message: "Pick a content type (Infographic / Meme-Image / LIC) before scheduling or posting."
  }
];

// Words that read as real English are a mix of vowels and consonants; a run
// of 6+ consonants or a 5+ letter word with no vowel at all almost never
// happens outside random keyboard-mashing ("asdkjfh", "qwsdfgh"). Numbers,
// hashtags, @mentions, and short words are skipped so real captions with
// handles/tags/stats aren't misjudged.
const CONSONANT_RUN = /[^aeiouAEIOU]{6,}/;
function looksLikeGibberishWord(word) {
  if (word.length < 5) return false;
  if (!/[aeiouAEIOU]/.test(word)) return true;
  return CONSONANT_RUN.test(word);
}

// HIGH-risk items that a person must eyeball before publishing — cannot be
// reliably auto-detected from text. Shown as a checklist on every post.
export const MANUAL_CHECKS = [
  { id: "m-hate",     severity: "HIGH", label: "No hate speech / protected-characteristic attacks (incl. in comment-bait framing)." },
  { id: "m-graphic",  severity: "HIGH", label: "No graphic injury/gore; combat-sport KOs or crash footage aren't shown without warning framing." },
  { id: "m-ip",       severity: "HIGH", label: "No unlicensed broadcast footage, league/team logos, or other outlets' exclusive photos/quotes." },
  { id: "m-ai",       severity: "HIGH", label: "Any AI-assisted image/video is labeled 'Made with AI' (Meta may auto-label via C2PA regardless)." },
  { id: "m-original", severity: "HIGH", label: "Video isn't just a repurposed clip — cosmetic edits (borders/captions/speed) don't count as transformation (Mar 2026 rule)." },
  { id: "m-music",    severity: "HIGH", label: "Any music is cleared through Meta's licensed library (common Reels demonetization trigger)." },
  { id: "m-thumb",    severity: "HIGH", label: "Video cover/thumbnail has no graphic, violent, or sexualized frame." },
  { id: "m-branded",  severity: "HIGH", label: "If sponsored: branded-content tool used + brand's written permission on file." },
  { id: "m-source",   severity: "MED",  label: "Licensed wire photos (Getty/AP) carry the required credit line." }
];

export function runCompliance(ctx) {
  const high = [], med = [], low = [];

  for (const rule of RULES) {
    let hit = false;
    try { hit = rule.test(ctx); } catch (e) { console.warn(`[compliance] rule "${rule.id}" threw:`, e.message); hit = false; }
    if (!hit) continue;
    const entry = { id: rule.id, label: rule.label, message: rule.message, policy: rule.policy, section: rule.section };
    if (rule.severity === "HIGH") high.push(entry);
    else if (rule.severity === "MED") med.push(entry);
    else low.push(entry);
  }

  return {
    high, med, low,
    manual: MANUAL_CHECKS,
    autoFlags: high.length + med.length + low.length,
    passed: high.length === 0
  };
}
