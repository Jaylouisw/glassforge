"use strict";
/**
 * A demand row's `label` and `address` are text, because both become node names.
 *
 * `engine/demand.js` copies a JSON row's fields out as-is, so `{ address: 5 }` used to reach the
 * design as a numeric node name. `network.validate` then refused the plant the design had just built:
 * nine candidates, each "node \"d1-ont-d3\" name must be a string, got a number", and an empty
 * `rejected` list that named no row. The CSV path could never do this - a cell is text - so the rule
 * here is the rule a cell already follows: a value is its text, or the row is refused by field.
 *
 *   - a string is itself, trimmed; a whitespace-only string says nothing, the way a CSV cell is trimmed
 *     to nothing and read as absent;
 *   - a finite number is its decimal text, so `{ address: 5 }` is the cell `"5"`;
 *   - anything else (an object, an array, a boolean, `NaN`) has no text reading and is refused, naming
 *     the field, rather than stringified into `"[object Object]"` or `"1,2"`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.textField = textField;
exports.renderValue = renderValue;
/** What a value is, for a refusal sentence: never `[object Object]`. */
function kindOf(value) {
    if (Array.isArray(value))
        return 'an array';
    if (value === null)
        return 'null';
    if (typeof value === 'object')
        return 'an object';
    if (typeof value === 'number')
        return String(value);
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    return typeof value;
}
/**
 * Read one field as text.
 *
 * `field` is the row's own key (`label`, `address`), so the refusal names the cell to fix and not the
 * node id in the plant it would have broken.
 */
function textField(value, field) {
    if (value === undefined || value === null)
        return { ok: true, text: null };
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return { ok: true, text: trimmed === '' ? null : trimmed };
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { ok: true, text: String(value) };
    }
    return {
        ok: false,
        reason: field + ' must be text (a string or a finite number), got ' + kindOf(value)
    };
}
/**
 * One-line rendering of a value for a rejection's `text`, which is what lets a planner find the row.
 *
 * The CSV path puts the raw row there. A JSON row's offender may be an object, and the API used to
 * echo that object back as the row's label; rendered here it is its JSON, truncated, so the refusal
 * reads as the cell rather than as `[object Object]`.
 */
function renderValue(value, max = 120) {
    let text;
    if (typeof value === 'string') {
        text = value.trim();
    }
    else if (value === undefined || value === null) {
        text = '';
    }
    else if (typeof value === 'number' || typeof value === 'boolean') {
        text = String(value);
    }
    else {
        try {
            const json = JSON.stringify(value);
            text = json === undefined ? (Array.isArray(value) ? '[]' : '{}') : json;
        }
        catch {
            // A circular or otherwise unserialisable value still gets a name, not a throw.
            text = Array.isArray(value) ? '[array]' : '[object]';
        }
    }
    return text.length > max ? text.slice(0, max) : text;
}
