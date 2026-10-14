/**
 * A text matcher for a line whose words are split across elements, such as a count that rolls in
 * its own number span ("<span>21</span>%" or "<span>10</span> models"). It matches the innermost
 * element whose whole visible text reads as given, the way a person reads the line.
 */
const normalize = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim()

export function wholeText(
  expected: string | RegExp
): (content: string, element: Element | null) => boolean {
  const matches = (text: string): boolean =>
    typeof expected === 'string' ? text === expected : expected.test(text)
  return (_content, element) =>
    element !== null &&
    matches(normalize(element.textContent)) &&
    Array.from(element.children).every((child) => !matches(normalize(child.textContent)))
}
