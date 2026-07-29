// Turns an uploaded reference image into a draft image-generation prompt, so an
// editor can start from an example instead of a blank prompt. Uses an
// OpenAI-style vision endpoint through the Vercel AI Gateway (or any compatible
// base URL). Env-gated: with no key, derive is unavailable and the caller hides
// the upload affordance.
const GATEWAY_KEY = () => process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const GATEWAY_BASE_URL = () => process.env.GROK_BASE_URL || "https://ai-gateway.vercel.sh/v1";
const VISION_MODEL = () => process.env.TEMPLATE_VISION_MODEL || "anthropic/claude-sonnet-4-5";
const TIMEOUT_MS = 30_000;

export function deriveEnabled() {
  return !!GATEWAY_KEY();
}

const SYSTEM_PROMPT = `You write image-to-image prompts for a sports Facebook card renderer.
Given a reference card image, describe a reusable PROMPT TEMPLATE that would recreate this exact visual
style/layout for a different subject. Rules the prompt MUST follow, no exceptions:
- Explicitly instruct: base the subject's face/likeness EXACTLY on the attached reference photo, do not
  reinterpret/stylize/idealize/cartoonize the face.
- Explicitly instruct the model to render on-image text as bold visible overlay text — never omit it,
  never say "no text"/"clean photo only".
- Use placeholders in curly braces for the variable parts: {headline}, {accent}, {kicker}, {accent_hex},
  {subject_name}, {quote_text}, {attributed_name}, {scene_description} — whichever apply to this layout.
- Describe the actual layout you see: text position/size, photo framing, kicker bar/color placement,
  background treatment (never suggest a flat solid-color background for the photo itself).
- End with a photorealism instruction ("photoreal press-photo quality, not illustrated/animated").
Return ONLY the prompt text itself, no preamble, no markdown fencing, no explanation.`;

// Returns { ok, prompt? , error? }. Never throws.
export async function deriveTemplatePrompt(imageDataUrl) {
  if (!GATEWAY_KEY()) return { ok: false, error: "Image derive is not configured (set AI_GATEWAY_API_KEY)." };
  if (!imageDataUrl || !/^data:image\//.test(imageDataUrl)) {
    return { ok: false, error: "A data:image/... URL is required." };
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GATEWAY_BASE_URL()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_KEY()}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: VISION_MODEL(),
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Here is the reference card. Write the reusable prompt template." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `vision model ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") return { ok: false, error: "Vision model returned no usable content." };
    return { ok: true, prompt: content.trim() };
  } catch (e) {
    return { ok: false, error: e.message || "Vision derive request failed." };
  } finally {
    clearTimeout(t);
  }
}
