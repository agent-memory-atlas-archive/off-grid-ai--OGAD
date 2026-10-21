/**
 * A request for the assistant to write code or a file itself ("Create a 3D starfield in a single
 * HTML file"). The answer is text in the chat. Tools that act elsewhere or make a picture only
 * tempt a small model away from it: Sage A1.5 sent such a request to web_use ("write the file to
 * /tmp and open it") and to generate_image ("Render hundreds of stars…").
 */
const BUILD_VERB = /\b(create|make|build|write|code|implement|generate|program)\b/i
const CODE_ARTIFACT =
  /\b(html|css|javascript|js|typescript|ts|python|script|canvas|webgl|three\.js|svg|react|component|function|code|program|app|game|page|file)\b/i

export function isAuthoringRequest(message: string): boolean {
  return BUILD_VERB.test(message) && CODE_ARTIFACT.test(message)
}

/** Tools an authoring request must not be offered unless the user names one. */
export const NON_AUTHORING_TOOLS: ReadonlySet<string> = new Set([
  'web_use',
  'computer_use',
  'open_url',
  'read_screen',
  'generate_image'
])
