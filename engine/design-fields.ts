/**
 * The budget design object is read through a fixed set of fields, and a near-miss is refused.
 *
 * `computeOdn` reads `spans`, `splices`, `connectors`, `splitters` and `thirdParty`; the budget
 * entry points read a handful more. A field the engine does not read is not a setting - it is a
 * typo, and it is the worst kind, because it removes loss without removing a number from the plan.
 *
 * Measured on this engine: `splitter: { model: 'plc-1x8-sca' }` (singular) on a 15 km GPON B+ design
 * budgets ODN **4.3 dB** instead of **14.8 dB** - the 10.5 dB splitter is silently gone, the
 * received power is 10.5 dB optimistic, and the verdict is computed on fibre that will not light.
 * `/api/design/budget` hands the caller's body straight to `opticalBudget`, so an API client makes
 * the same mistake and gets a `200`.
 *
 * The refusal is deliberately narrow: it fires on a field that is a *near miss* of one the engine
 * does read - case difference, singular/plural, a prefix (`margin` for `marginDb`) or a one-letter
 * edit - and says which field was meant. Unrelated extra keys (`name`, `notes`, a caller's own
 * bookkeeping) are still ignored, because refusing those would make the budget unusable for a
 * caller who is not wrong. This module cannot be sure a word is a typo; it can be sure that
 * `splitter` is one.
 */

/** A field name the engine reads. `readonly` so a caller cannot edit the list it is checked against. */
export type FieldList = readonly string[];

/** Damerau-free Levenshtein distance, iterative: enough for "one letter wrong" on short names. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev: number[] = new Array(b.length + 1);
  const cur: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a.charAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charAt(j - 1) ? 0 : 1;
      const del = (prev[j] as number) + 1;
      const ins = (cur[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;
      cur[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] as number;
  }
  return prev[b.length] as number;
}

/**
 * The field the caller probably meant, or null when the key is not a near miss of any known field.
 *
 * Order of certainty: an exact case-insensitive match first (so the message can name the real
 * casing, `headEnd`), then singular/plural, then a prefix, then one edit. The shortest candidate
 * wins a tie, and ids break the remaining tie, so the suggestion is deterministic.
 */
export function suggestField(field: string, known: FieldList): string | null {
  const lower = field.toLowerCase();
  for (const candidate of known) {
    if (candidate.toLowerCase() === lower) return candidate;
  }

  const hits: string[] = [];
  for (const candidate of known) {
    const cl = candidate.toLowerCase();
    const plural = cl === lower + 's' || lower === cl + 's';
    // 4 is the floor where a prefix means something: `tx` is a fragment, `margin` is a word.
    const prefix = lower.length >= 4 && cl.length >= 4 && cl.indexOf(lower) === 0;
    const near = lower.length >= 4 && cl.length >= 4 && distance(lower, cl) <= 1;
    if (plural || prefix || near) hits.push(candidate);
  }
  if (!hits.length) return null;
  hits.sort(function (a, b) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return hits[0] as string;
}

/**
 * Refuse a design whose key is a near miss of a field the budget reads.
 *
 * `design` is `unknown` because it arrives as API JSON. A non-object is not this guard's business -
 * the entry point names the missing `olt.model`/`headEnd.model` itself.
 */
export function assertKnownFields(design: unknown, known: FieldList, what: string): void {
  if (typeof design !== 'object' || design === null || Array.isArray(design)) return;
  const keys = Object.keys(design as Record<string, unknown>);
  for (const key of keys) {
    if (known.indexOf(key) !== -1) continue;
    const suggestion = suggestField(key, known);
    if (suggestion === null) continue;
    throw new TypeError(what + ' does not read the design field "' + key + '" - did you mean "' +
      suggestion + '"? A field the engine ignores loses the loss it names without saying so, so a ' +
      'near miss is refused rather than skipped. Fields it reads: ' + known.join(', '));
  }
}
