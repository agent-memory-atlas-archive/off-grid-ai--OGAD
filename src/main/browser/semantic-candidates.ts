// Decision + Reasoning proposes 1 to 3 candidate actions for the Decision model to choose
// from. Each is validated on its own: one malformed proposal (a click with no ref) is dropped
// rather than failing the whole web task, while an invalid action is still never offered or
// run. Only when no proposal is valid does the step fail, with the first validator error.

export function keepValidCandidates<T>(raw: readonly unknown[], parse: (value: unknown) => T): T[] {
  const valid: T[] = []
  let firstError: unknown = null
  for (const candidate of raw) {
    try {
      valid.push(parse(candidate))
    } catch (error) {
      firstError ??= error
    }
  }
  if (valid.length === 0) throw firstError ?? new Error('No candidate action was proposed.')
  if (valid.length < raw.length) {
    console.warn('[web-use][semantic] dropped invalid candidates', {
      proposed: raw.length,
      kept: valid.length
    })
  }
  return valid
}
