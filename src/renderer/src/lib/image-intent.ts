// Image prompt cleanup. Whether a message is an image request is the model's call: MiniLM offers
// generate_image when the request is for a picture (main/tools/tool-intent.ts).

/** Strip the leading "draw/generate an image of" phrasing so the diffusion prompt
 *  is just the subject. Falls back to the original text if stripping empties it. */
export function cleanImagePrompt(text: string): string {
  const stripped = text
    .trim()
    .replace(
      /^\s*(?:please\s+|can you\s+|could you\s+)?(?:draw|sketch|paint|illustrate|render|generate|create|make|design|produce|show me|give me)\b\s*/i,
      ''
    )
    .replace(
      /^(?:me\s+)?(?:an?|the)\s+(?:image|picture|photo(?:graph)?|drawing|painting|illustration|art(?:work)?|logo|wallpaper|poster|portrait)\s+of\s+/i,
      ''
    )
    .replace(/^(?:of|for)\s+/i, '')
    .trim()
  return stripped || text.trim()
}
