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
 * does read - case difference, singular/plural, a prefix (`margin` for `marginDb`) or a one-letter
 * edit - and says which field was meant. Unrelated extra keys (`name`, `notes`, a caller's own
 * bookkeeping) are still ignored, because refusing those would make the budget unusable for a
 * caller who is not wrong. This module cannot be sure a word is a typo; it can be sure that
 * `splitter` is one.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestField = suggestField;
exports.assertKnownFields = assertKnownFields;
exports.assertNumberField = assertNumberField;
exports.assertChoiceField = assertChoiceField;
/** Damerau-free Levenshtein distance, iterative: enough for "one letter wrong" on short names. */
function distance(a, b) {
    if (a === b)
        return 0;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++)
        prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        const ai = a.charAt(i - 1);
        for (let j = 1; j <= b.length; j++) {
            const cost = ai === b.charAt(j - 1) ? 0 : 1;
            const del = prev[j] + 1;
            const ins = cur[j - 1] + 1;
            const sub = prev[j - 1] + cost;
            cur[j] = Math.min(del, ins, sub);
        }
        for (let j = 0; j <= b.length; j++)
            prev[j] = cur[j];
    }
    return prev[b.length];
}
/**
 * The field the caller probably meant, or null when the key is not a near miss of any known field.
 *
 * Order of certainty: an exact case-insensitive match first (so the message can name the real
 * casing, `headEnd`), then singular/plural, then a prefix, then one edit. The shortest candidate
 * wins a tie, and ids break the remaining tie, so the suggestion is deterministic.
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
/**
 * Refuse a design whose key is a near miss of a field the budget reads.
 *
 * `design` is `unknown` because it arrives as API JSON. A non-object is not this guard's business -
 * the entry point names the missing `olt.model`/`headEnd.model` itself.
 */
function assertKnownFields(design, known, what) {
    if (typeof design !== 'object' || design === null || Array.isArray(design))
        return;
    const keys = Object.keys(design);
    for (const key of keys) {
        if (known.indexOf(key) !== -1)
            continue;
        const suggestion = suggestField(key, known);
        if (suggestion === null)
            continue;
        throw new TypeError(what + ' does not read the design field "' + key + '" - did you mean "' +
            suggestion + '"? A field the engine ignores loses the loss it names without saying so, so a ' +
            'near miss is refused rather than skipped. Fields it reads: ' + known.join(', '));
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
/**
 * Refuse a design field the budget reads *as a number* when the value is not one, or is below `min`.
 *
 * The sibling of `assertKnownFields`, and it exists for the same measured reason. A field the engine
 * cannot read is not a setting - but neither is one it reads and cannot use, and this one is worse,
 * because the key is right and nothing complains. Measured on this engine, on a GPON B+ design of
 * 20 km at 1:64 (ODN 27.70 dB, -26.20 dBm into a -27 dBm receiver, 0.80 dB of headroom against a 3 dB
 * margin, verdict `fail`):
 *
 *   marginDb: -5      read straight into `headroomDb < marginDb`, so 0.80 < -5 is false - `marginal`
 *   allowanceDb: -3   subtracted from ODN loss instead of added: 24.70 dB, -23.20 dBm, `marginal`
 *   marginDb: '3'     `isNum('3')` is false, so it fell back to the default 3 - right by luck
 *   allowanceDb: '2'  fell back to 0: the caller's 2 dB of allowance vanished from the plan
 *
 * Every one of those moves the verdict in the optimistic direction, and `/api/design/budget` hands the
 * caller's body straight in, so an API client makes the mistake and gets a `200` with a verdict.
 *
 * `design` is `unknown` because it arrives as API JSON; a non-object is the entry point's business.
 * A field that is absent is absent - the budget's own default applies and is reported in the result.
 */
function assertNumberField(design, field, min, what) {
    if (typeof design !== 'object' || design === null || Array.isArray(design))
        return;
    const value = design[field];
    if (value === undefined)
        return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(what + ' reads "' + field + '" as a number of dB and got ' + showValue(value) +
            ' (' + kindOf(value) + '). A value it cannot use is refused rather than skipped: a reserve that ' +
            'is ignored leaves a verdict computed without the loss the caller asked for.');
    }
    if (value < min) {
        throw new TypeError(what + ' reads "' + field + '" as a number of dB at or above ' + min +
            ' and got ' + showValue(value) + '. A design reserve is loss the route is allowed to spend, so a ' +
            'negative one is not a small reserve - it passes links that are short of the reserve it names.');
    }
}
/**
 * Refuse a design field that picks one of a fixed set when its value is not in that set.
 *
 * `design.direction === 'up' ? 'up' : 'down'` answered a downstream budget to a caller who asked for
 * something else. The two are different networks, not two spellings of one: downstream is the ONT's
 * receiver at 1490 nm, upstream the OLT's at 1310 nm, so the wrong branch is a wrong receiver at a
 * wrong wavelength. The result does echo `direction`, but a typo a caller has to spot in the answer
 * is a typo that reaches the plan. Nothing is refused for *being absent*: the default still applies.
 */
function assertChoiceField(design, field, allowed, what) {
    if (typeof design !== 'object' || design === null || Array.isArray(design))
        return;
    const value = design[field];
    if (value === undefined)
        return;
    if (typeof value === 'string' && allowed.indexOf(value) !== -1)
        return;
    const quoted = allowed.map(function (v) { return '"' + v + '"'; });
    throw new TypeError(what + ' reads "' + field + '" as one of ' + quoted.join(', ') + ' and got ' +
        showValue(value) + ' (' + kindOf(value) + '). A direction it cannot place is refused rather than ' +
        'read as "' + String(allowed[allowed.length - 1]) + '": the two directions are different receivers ' +
        'at different wavelengths.');
}
