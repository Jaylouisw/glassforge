/**
 * The Signal tab's view of a budget: one ODN, two directions.
 *
 * A PON is two links over the same glass - the OLT launching into the ONT at 1490 nm, and the ONT
 * launching into the OLT at 1310 nm - and the two disagree exactly where it costs money: a C+ card
 * behind 11.53 dB of ODN is `ok` downstream (with the launch-window warning and a 4 dB pad) and
 * `fail` upstream, -11.22 dBm onto a receiver whose overload is -12 dBm (#185). The tab asked for the
 * default direction alone, so the surface that exists to answer "is this plant audible" answered half
 * the question.
 *
 * The join and the row wording live here rather than inside the builder for the reason `dom.js`
 * exists: a rule buried in a render function can only be asserted by grepping the render function.
 * This one is a value in and a value out, and the test drives it with the payloads the server really
 * answers.
 *
 * Works in the browser (`GFSignal`) and in Node (`module.exports`).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GFSignal = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The heading of one direction: the engine's own words for it, never a constant of ours. */
  function title(result) {
    return (result.direction === 'up' ? 'Upstream' : 'Downstream') + ' · ' + result.wavelength + ' nm';
  }

  /**
   * The figures one direction's verdict was made from, as `[label, value]` pairs.
   *
   * The class row is a PON row. An active pair is budgeted by `budget.pointToPoint`, which carries no
   * `pon` and no `oltClass` - its budget is the optic pair's, not an ODN class - and asking it for
   * one printed `ODN loss 0.35 dB of 9.8 dB undefined undefined` on every head-end plant.
   */
  function rows(result) {
    const out = [
      ['Rx power', result.rxPowerDbm + ' dBm'],
      ['Sensitivity', result.sensitivityDbm + ' dBm (overload ' + result.overloadDbm + ')'],
      ['Headroom', result.headroomDb + ' dB (margin ' + result.marginDb + ')']
    ];
    out.push(['ODN loss', result.pon
      ? result.odnLossDb + ' dB of ' + result.budgetDb + ' dB ' + result.pon + ' ' + result.oltClass
      : result.odnLossDb + ' dB of ' + result.budgetDb + ' dB']);
    out.push(['Class headroom', result.classHeadroomDb + ' dB']);
    out.push(['Cascade', '1:' + result.cascadeRatio]);
    return out;
  }

  /**
   * Join the two passes onto the downstream rows.
   *
   * The downstream pass is the row list: it is the set of ONTs, in the plant's order. An upstream
   * row is matched by ONT id and rides on its card.
   *
   * - An ONT that cannot be budgeted at all carries `error` downstream, and that is a fault in the
   *   path, not in one direction: the upstream pass fails on the same path. `up` and `upError` stay
   *   null so the card says it once.
   * - An upstream pass that returned nothing (`upRows` null, or a shorter list) leaves `up` null on
   *   the cards it did not answer, rather than inventing a verdict for them.
   */
  function merge(downRows, upRows) {
    const upstream = new Map();
    for (const row of upRows || []) upstream.set(String(row.ont), row);
    return (downRows || []).map(function (row) {
      const other = upstream.get(String(row.ont)) || null;
      const broken = !!row.error;
      return {
        ont: row.ont,
        name: row.name === undefined ? null : row.name,
        error: row.error || null,
        down: broken ? null : (row.result || null),
        up: broken || !other || !other.result ? null : other.result,
        upError: broken || !other || !other.error ? null : other.error
      };
    });
  }

  return { title: title, rows: rows, merge: merge };
});
