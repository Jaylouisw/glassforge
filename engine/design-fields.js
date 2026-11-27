"use strict";
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
 * does read - case difference, singular/plural, a prefix (`margin` for `marginDb`), a one-letter edit
 * or a swapped adjacent pair (`marignDb` for `marginDb`) - and says which field was meant. Unrelated
 * extra keys (`name`, `notes`, a caller's own bookkeeping) are still ignored, because refusing those
 * would make the budget unusable for a caller who is not wrong. This module cannot be sure a word is a typo; it can be sure that
 * `splitter` is one.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestField = suggestField;
exports.assertKnownFields = assertKnownFields;
exports.assertNumberField = assertNumberField;
exports.assertChoiceField = assertChoiceField;
exports.assertCableLadder = assertCableLadder;
/**
 * Levenshtein distance with adjacent transpositions (optimal string alignment, Damerau), iterative.
 *
 * Plain Levenshtein counts a swapped pair as two edits - a deletion plus an insertion - so the typo a
 * hand on a keyboard makes most often (`marignDb`, `overlenghtPct`, `thridParty`) was not a near miss
 * at all, and the guard silently let the default run. One swap is one keystroke, so it is one edit
 * here. Three rows are kept because the transposition step reads the row two back.
 */
function distance(a, b) {
    if (a === b)
        return 0;
    const m = b.length;
    let twoBack = new Array(m + 1).fill(0);
    let prev = new Array(m + 1);
    let cur = new Array(m + 1);
    for (let j = 0; j <= m; j++)
        prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        const ai = a.charAt(i - 1);
        for (let j = 1; j <= m; j++) {
            const cost = ai === b.charAt(j - 1) ? 0 : 1;
            const del = prev[j] + 1;
            const ins = cur[j - 1] + 1;
            const sub = prev[j - 1] + cost;
            let best = Math.min(del, ins, sub);
            // `ab` -> `ba` is one transposition, not a deletion plus an insertion.
            if (i > 1 && j > 1 && ai === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
                const swap = twoBack[j - 2] + 1;
                if (swap < best)
                    best = swap;
            }
            cur[j] = best;
        }
        const recycled = twoBack;
        twoBack = prev;
        prev = cur;
        cur = recycled;
    }
    return prev[m];
}
/**
 * The field the caller probably meant, or null when the key is not a near miss of any known field.
 *
 * Order of certainty: an exact case-insensitive match first (so the message can name the real
 * casing, `headEnd`), then singular/plural, then a prefix, then one edit (a swap is one edit). The
 * shortest candidate wins a tie, and ids break the remaining tie, so the suggestion is deterministic.
 */
function suggestField(field, known) {
    const lower = field.toLowerCase();
    for (const candidate of known) {
        if (candidate.toLowerCase() === lower)
            return candidate;
    }
    const hits = [];
    for (const candidate of known) {
        const cl = candidate.toLowerCase();
        const plural = cl === lower + 's' || lower === cl + 's';
        // 4 is the floor where a prefix means something: `tx` is a fragment, `margin` is a word.
        const prefix = lower.length >= 4 && cl.length >= 4 && cl.indexOf(lower) === 0;
        const near = lower.length >= 4 && cl.length >= 4 && distance(lower, cl) <= 1;
        if (plural || prefix || near)
            hits.push(candidate);
    }
    if (!hits.length)
        return null;
    hits.sort(function (a, b) {
        if (a.length !== b.length)
            return a.length - b.length;
        return a < b ? -1 : a > b ? 1 : 0;
    });
    return hits[0];
}
/** The budget's wording - the default, because four refusals already read exactly this way. */
const DEFAULT_NEAR_MISS_NOUN = 'design field';
const DEFAULT_NEAR_MISS_CONSEQUENCE = 'A field the engine ignores loses the loss it names without saying so, so a ' +
    'near miss is refused rather than skipped.';
/**
 * Refuse a design whose key is a near miss of a field the budget reads.
 *
 * `design` is `unknown` because it arrives as API JSON. A non-object is not this guard's business -
 * the entry point names the missing `olt.model`/`headEnd.model` itself.
 *
 * `wording` exists because the same rule is now applied to a module whose terms are not losses.
 * `engine/length.js` reads nine options and answers with a purchase order, so its refusal has to say
 * that the check is about **metres** - a sentence about a lost loss is the wrong cause for a caller
 * who typed `drumm` and bought a cable. Both halves default to the budget's own words, so every
 * existing refusal reads byte for byte as before.
 */
function assertKnownFields(design, known, what, wording) {
    if (typeof design !== 'object' || design === null || Array.isArray(design))
        return;
    const noun = wording !== undefined && wording.noun !== undefined ? wording.noun : DEFAULT_NEAR_MISS_NOUN;
    const consequence = wording !== undefined && wording.consequence !== undefined
        ? wording.consequence
        : DEFAULT_NEAR_MISS_CONSEQUENCE;
    const keys = Object.keys(design);
    for (const key of keys) {
        if (known.indexOf(key) !== -1)
            continue;
        const suggestion = suggestField(key, known);
        if (suggestion === null)
            continue;
        throw new TypeError(what + ' does not read the ' + noun + ' "' + key + '" - did you mean "' +
            suggestion + '"? ' + consequence + ' Fields it reads: ' + known.join(', '));
    }
}
/**
 * A value said back the way the caller sent it.
 *
 * JSON.stringify is the only rendering that keeps a string a string: `String("2")` prints `2`, which
 * reads as the number the caller meant, so a refusal built on `String` tells somebody their `2` is
 * wrong when what was wrong is the quotes around it. A number prints as itself; anything JSON cannot
 * express is named by kind, because there is no useful text for it.
 */
function showValue(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'an array';
    if (typeof value === 'object')
        return 'an object';
    return typeof value;
}
/** `a string`, `a number`, `an object` - so the refusal names the cause and not only the field. */
function kindOf(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'an array';
    return 'a ' + typeof value;
}
/** The budget knobs' wording - the default, so the refusals #147 pinned read exactly as they did. */
const RESERVE_WORDING = {
    measure: 'a number of dB',
    unusable: 'A value it cannot use is refused rather than skipped: a reserve that is ignored leaves a ' +
        'verdict computed without the loss the caller asked for.',
    belowMin: 'A design reserve is loss the route is allowed to spend, so a negative one is not a small ' +
        'reserve - it passes links that are short of the reserve it names.'
};
function assertNumberField(design, field, min, what, wording) {
    if (typeof design !== 'object' || design === null || Array.isArray(design))
        return;
    const value = design[field];
    if (value === undefined)
        return;
    const text = Object.assign({}, RESERVE_WORDING, wording || {});
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(what + ' reads "' + field + '" as ' + text.measure + ' and got ' + showValue(value) +
            ' (' + kindOf(value) + '). ' + text.unusable);
    }
    if (value < min) {
        throw new TypeError(what + ' reads "' + field + '" as ' + text.measure + ' at or above ' + min +
            ' and got ' + showValue(value) + '. ' + text.belowMin);
    }
}
function assertChoiceField(design, field, allowed, what, wording) {
    if (typeof design !== 'object' || design === null || Array.isArray(design))
        return;
    const value = design[field];
    if (value === undefined)
        return;
    if (typeof value === 'string' && allowed.indexOf(value) !== -1)
        return;
    const quoted = allowed.map(function (v) { return '"' + v + '"'; });
    const why = (wording && wording.wrong) || ('A direction it cannot place is refused rather than ' +
        'read as "' + String(allowed[allowed.length - 1]) + '": the two directions are different receivers ' +
        'at different wavelengths.');
    throw new TypeError(what + ' reads "' + field + '" as one of ' + quoted.join(', ') + ' and got ' +
        showValue(value) + ' (' + kindOf(value) + '). ' + why);
}
/**
 * A cable ladder the design cannot use is refused, not read as the default ladder.
 *
 * `ladder` is the last knob still normalised with `Array.isArray(o.ladder) && o.ladder.length ? … :
 * DEFAULTS.ladder`, and it is the one that decides **what is bought**: every span goes through
 * `cableForSpan(cableFor)`, so the list is the BOM. Measured on this engine, an 8-house PON estate:
 *
 *   ladder: 'g652d-loose-48'        read as DEFAULT_LADDER - same 686.7 m of cable, but 5,890.2
 *                                   fibre-metres on five 12-fibre trunk spans instead of 22,569 on
 *                                   48-fibre. The objective ranks on fibre-metres, and the order is
 *                                   placed against the model.
 *   ladder: ['g652d-nope', …]       threw only when a span asked for it, from a sentence that named no
 *                                   field: "the cable ladder names no cable this catalogue has: …". An
 *                                   unused bad entry in a ladder that still fits was never noticed.
 *
 * An absent ladder, or an empty one, is not a mistake: it takes the design's default and the design
 * says which ladder that was in `notes`. Everything else - a bare model name, a list with a number in
 * it, a model the cable catalogue does not have - is caller input the design would otherwise read as
 * the default, so it is refused by name at its position, and an unknown model names the catalogue.
 *
 * `isCable` and `catalogue` keep this module free of the registry: the caller knows the cables it has.
 */
function assertCableLadder(value, isCable, catalogue, what) {
    if (value === undefined)
        return;
    const known = catalogue.join(', ');
    if (!Array.isArray(value)) {
        throw new TypeError(what + ' reads "ladder" as a list of cable model names and got ' + showValue(value) +
            ' (' + kindOf(value) + '). A ladder of another shape is refused rather than read as the default ' +
            'ladder, because every span would then be bought from a cable the caller left out. Pass a list, ' +
            'or omit it (or pass []) for the default. Cable models: ' + known + '.');
    }
    for (let i = 0; i < value.length; i++) {
        const model = value[i];
        if (typeof model !== 'string' || model === '') {
            throw new TypeError(what + ' reads "ladder" as cable model names and got ' + showValue(model) +
                ' (' + kindOf(model) + ') at position ' + i + '. Cable models: ' + known + '.');
        }
        if (!isCable(model)) {
            throw new TypeError(what + ' reads "ladder" as cable model names and "' + model + '" is not in the ' +
                'cable catalogue (position ' + i + '). Cable models: ' + known + '.');
        }
    }
}
