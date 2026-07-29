// Seed library for the Design Template page — parameterized image-generation
// prompts ported from the es-page-registry template library. Each bakes in the
// two hard rules (face-lock to the reference photo, explicit overlay text) so an
// editor starts from a compliant baseline. Placeholders use {curly_braces}.
export const DEFAULT_DESIGN_TEMPLATES = [
  {
    key: "version_b",
    name: "Version B — Hero",
    description:
      'Magazine-grade full-bleed hero card for milestones, results, and breaking news. One dominant athlete, big condensed name, colored kicker bar.',
    story_types: ["milestone", "record", "breaking", "result"],
    prompt:
      "Sports infographic card, 3:4 portrait. Base the subject's face and likeness EXACTLY on the attached reference photo — do not reinterpret, stylize, or generalize the face. Full-bleed dominant athlete shot, lower 65% of frame, knees-up, face clearly visible, in correct current kit, real blurred crowd/stadium background — never a flat color background. Display as bold visible overlay text: giant white CONDENSED ALL-CAPS HEADLINE: '{headline}' (top, under a dark scrim), solid {accent_hex} kicker bar with white ALL-CAPS ACCENT: '{accent}', short white ALL-CAPS sub-line KICKER: '{kicker}'. Leave top-right ~12-15% clear for a logo to be composited separately. Photoreal press-photo quality, not illustrated/animated.",
  },
  {
    key: "quote_card",
    name: "Quote Card",
    description:
      "One or two-person quote card — giant quote mark, the quote itself as the main on-image text, attribution line below.",
    story_types: ["quote"],
    prompt:
      "Sports quote card, 3:4 portrait, full-bleed. Base the subject's face and likeness EXACTLY on the attached reference photo(s) — do not reinterpret or stylize. Real headshot/upper-body photo of {subject_name}, correct current look. Giant opening quotation mark in {accent_hex} positioned top-left. Display the quoted line as large high-contrast overlay text filling the middle third: '{quote_text}'. Attribution line below in smaller type: '— {attributed_name}, {role_context}'. Accent color applies only to the quote mark and attribution line — the photo itself stays real and untouched. Photoreal, not illustrated.",
  },
  {
    key: "standard_editorial",
    name: "Standard Editorial Card",
    description:
      "Default for debate/feature/legacy/comparison evergreen posts — dark headline block on top, real subject photo below, single-word colored kicker bar at the bottom edge.",
    story_types: ["debate", "feature", "legacy", "comparison"],
    prompt:
      "Sports infographic card, 3:4 portrait. Base the subject's face and likeness EXACTLY on the attached reference photo — do not reinterpret, stylize, idealize, or cartoonize the face. Top ~55-60%: solid dark/black background carrying a 2-3 line stacked bold white ALL-CAPS HEADLINE: '{headline}' (a statement or a genuine question) — text sits on the dark field, never over the photo. Bottom ~40-45%: the subject's real photo, natural/candid frame (press conference, in-action, formal portrait). Bottom edge: solid {accent_hex} kicker bar with ONE bold white ALL-CAPS word: '{kicker}'. Photoreal press-photo quality, not illustrated/animated.",
  },
  {
    key: "milestone_montage",
    name: "Milestone Montage",
    description: "Career/statistical milestone hero montage — dynamic action shot with the milestone number front and center.",
    story_types: ["milestone", "record"],
    prompt:
      "Sports milestone montage card, 3:4 portrait. Base the subject's face and likeness EXACTLY on the attached reference photo. Dynamic action shot of {subject_name} in correct current kit, dramatic stadium/arena lighting, real depth and crowd. Display as bold overlay text: HEADLINE: '{headline}' (large, top), the milestone number/stat prominently displayed as ACCENT: '{accent}', KICKER: '{kicker}' (lower bar in {accent_hex}). Photoreal, not illustrated.",
  },
  {
    key: "career_tribute",
    name: "Career Tribute",
    description: "Legend/retirement/career tribute montage — reverent, retrospective tone. Reproduces the subject's real, era-appropriate look; never idealized or de-aged.",
    story_types: ["throwback", "legacy", "tribute"],
    prompt:
      "Sports career tribute card, 3:4 portrait, warm reverent tone. Base the subject's face and likeness EXACTLY on the attached reference photo — reproduce their real, era-appropriate appearance, do not idealize or de-age. Classic/throwback-styled photo of {subject_name} in their signature kit/moment. Display as bold overlay text: HEADLINE: '{headline}', ACCENT: '{accent}' in {accent_hex}, KICKER: '{kicker}' (tribute/legacy framing). Photoreal, not illustrated.",
  },
  {
    key: "dramatic_news",
    name: "Dramatic News",
    description: "Single-subject dramatic breaking/update news card, real in-context scene.",
    story_types: ["breaking", "update", "news"],
    prompt:
      "Sports breaking news card, 3:4 portrait, high drama. Base the subject's face and likeness EXACTLY on the attached reference photo. {subject_name} in a real in-context scene (game action, press conference, or event backdrop) matching the story — never a flat background. Display as bold overlay text: HEADLINE: '{headline}' (large, top), ACCENT: '{accent}' in {accent_hex}, KICKER: '{kicker}' (lower bar, the key new fact). Photoreal press-photo quality, not illustrated.",
  },
  {
    key: "congrats_award",
    name: "Congrats / Award",
    description: "Award or achievement congratulations card — celebratory tone.",
    story_types: ["award", "milestone"],
    prompt:
      "Sports congratulations/award card, 3:4 portrait, celebratory tone. Base the subject's face and likeness EXACTLY on the attached reference photo. {subject_name} in a celebratory moment (trophy, award ceremony, or victory pose) in correct current attire. Display as bold overlay text: HEADLINE: '{headline}', ACCENT: '{accent}' in {accent_hex}, KICKER: '{kicker}'. Photoreal, not illustrated.",
  },
  {
    key: "icon_bullet_explainer",
    name: "Icon-Bullet Explainer",
    description: "3-things/explainer card with short icon-style bullet callouts alongside a portrait.",
    story_types: ["feature", "explainer"],
    prompt:
      "Sports explainer infographic card, 3:4 portrait. Base the subject's face and likeness EXACTLY on the attached reference photo. {subject_name} portrait on one side, real photo, correct current look. Display as bold overlay text: HEADLINE: '{headline}' (top), then 3 short icon-style bullet callouts in {accent_hex} accent color: '{bullet_1}', '{bullet_2}', '{bullet_3}'. Photoreal, not illustrated; text must be legible and correctly spelled.",
  },
  {
    key: "cinematic_teaser",
    name: "Cinematic Concept Teaser",
    description: "Mood/concept art for speculative or what-if angles ONLY — not for a real named athlete's likeness.",
    story_types: ["feature", "whatif"],
    prompt:
      "Cinematic concept teaser card, 3:4 portrait, moody atmospheric lighting. This template is for CONCEPT/mood art only — if the story is about a real named athlete's real likeness, use a different template instead of this one. Scene: {scene_description}. Display as bold overlay text: HEADLINE: '{headline}', KICKER: '{kicker}' in {accent_hex}. No fake logos/badges anywhere on the card.",
  },
  {
    key: "comparison_card",
    name: "Comparison Card",
    description: "Genuine two-subject head-to-head — both named subjects visible side-by-side.",
    story_types: ["comparison", "versus"],
    prompt:
      "Sports comparison card, 3:4 portrait, split-frame composition. Base Subject A's face and likeness EXACTLY on reference photo 1 — do not reinterpret, stylize, idealize, swap, or blend. Base Subject B's face and likeness EXACTLY on reference photo 2 — do not reinterpret, stylize, idealize, swap, or blend. {subject_a_name} on the left half in current kit/context, {subject_b_name} on the right half in current kit/context, a clean accent-color divider or 'VS' mark between them in {accent_hex}. Display as bold overlay text: HEADLINE: '{headline}' spanning the top, one short stat/label under each subject if the story is stat-driven: '{stat_a}' / '{stat_b}'. Photoreal press-photo quality, not illustrated/animated. Both faces must be independently correct.",
  },
  {
    key: "collage_card",
    name: "Collage Card",
    description: "Multi-athlete/multi-moment round-ups (Top 5, multi-player tribute) that don't reduce to one photo.",
    story_types: ["feature", "ranking", "tribute"],
    prompt:
      "Sports collage infographic card, 3:4 portrait, clean multi-panel or grid composition. This card includes {subject_count} subjects — base EACH subject's face and likeness EXACTLY on their own corresponding reference photo (subject 1 on reference photo 1, subject 2 on reference photo 2, and so on) — do not reinterpret, stylize, idealize, swap, or blend any face. Each subject in their own current kit/context within their own panel. Display as bold overlay text: HEADLINE: '{headline}' spanning the top, one short label per panel if useful: '{label_1}', '{label_2}', etc. Accent color {accent_hex} on dividers/labels only. Photoreal press-photo quality, not illustrated/animated. Every subject must independently pass likeness verification.",
  },
];
