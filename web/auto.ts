/**
 * The Auto tab's candidate table: which columns it has, and what goes in each cell.
 *
 * `design.synthesise` answers a table of candidates and ranks them, and the table on the page is
 * where that ranking is read. It was a hand-written header array and a hand-written cell list in
 * `app.js`, which meant two things the response carries never reached the reader:
 *
 * 1. **The number the ranking used, whenever the ranking was money.** With a `costs` model the
 *    engine ranks by `metrics.cost` and says so in `objective` - and the table had no cost column,
 *    so a plan chosen for 9,328 was compared on cable metres and fibre-metres.
 * 2. **The upstream direction of every ONT's link.** A PON is two links over one ODN, and
 *    `metrics.upstreamFailOnts` counts the ones that fail ONT -> OLT. On the 12-house C+ estate this
 *    repo's own auto-design suite builds, the winner by fibre-metres (PON 1:8) is 12 of 12 ONTs
 *    failed upstream while the 1:16 and 1:32 candidates are 0 of 12 (#185) - a trade-off that was
 *    invisible in the table that offers the design.
 *
 * Counted, not gated: a candidate whose upstream direction fails is still ranked and still offered,
 * because whether that should gate feasibility is the open decision in #185. The column says the
 * number; it does not move the verdict.
 *
 * Header and cells are built from **one list of keys** and **one value function**, so a column
 * cannot appear in the header and be missing from the row - the alignment bug this replaces had the
 * infeasible-reason row hard-coded to `colspan: 8`.
 *
 * Works in the browser (global `GFAuto`) and in Node (`module.exports`), like `scene.js` and
 * `signal.js`, so `test/auto-candidate-table.test.js` drives it with the payloads the engine really
 * answers.
 */
interface AutoRoot { [key: string]: unknown }

interface CandidateMetrics {
  onts: number;
  cableM: number;
  fibreMetres: number;
  closures: number;
  splitters: number;
  worstHeadroomDb: number | null;
  cost?: number | null;
  upstreamFailOnts?: number | null;
}

interface AutoCandidate {
  label: string;
  feasible: boolean;
  metrics: CandidateMetrics;
}

interface AutoColumn {
  key: string;
  label: string;
  hint: string | null;
}

interface AutoCell {
  text: string;
  cls: string;
}

(function (root: AutoRoot | undefined, factory: () => unknown): void {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.GFAuto = api;
})(typeof self !== 'undefined' ? (self as unknown as AutoRoot) : undefined, function () {
  'use strict';

  const LABELS: { [key: string]: string } = {
    topology: 'Topology',
    feasible: 'Feasible',
    cableM: 'Cable m',
    fibreMetres: 'Fibre-m',
    cost: 'Cost',
    onts: 'ONT',
    splitters: 'SPL',
    closures: 'Closure',
    worstHeadroomDb: 'Worst dB',
    upstreamFailOnts: 'Up fail'
  };

  const HINTS: { [key: string]: string } = {
    cost: 'Priced on the purchased metres (every drum the BOM buys) plus the per-unit splices, ' +
      'closures and splitters - the number this candidate was ranked by.',
    upstreamFailOnts: 'ONT links that fail upstream (ONT -> OLT): the OLT receiver is over its ' +
      'overload point, or there is not enough headroom. Counted, not gated - the candidate is still ' +
      'ranked (#185); the Signal tab names the pad that clears it.'
  };

  /**
   * The columns, in order. `objective` is the response's own word (`cost` or `fibre-metres`), never
   * re-derived here: a table that decided for itself which number was ranked would be a second
   * opinion on the engine's answer.
   */
  function columns(objective?: string | null): AutoColumn[] {
    const keys: string[] = ['topology', 'feasible', 'cableM', 'fibreMetres'];
    if (objective === 'cost') keys.push('cost');
    keys.push('onts', 'splitters', 'closures', 'worstHeadroomDb', 'upstreamFailOnts');
    return keys.map(function (key: string): AutoColumn {
      return { key: key, label: LABELS[key], hint: HINTS[key] || null };
    });
  }

  function isNum(value: unknown): value is number {
    return typeof value === 'number' && isFinite(value);
  }

  /** An absent figure is a dash, never a zero: "no figure" and "nothing" are not one answer. */
  function figure(value: number | null | undefined): string {
    return isNum(value) ? String(value) : '—';
  }

  function textFor(key: string, candidate: AutoCandidate): string {
    const m = candidate.metrics;
    switch (key) {
      case 'topology': return candidate.label;
      case 'feasible': return candidate.feasible ? 'yes' : 'no';
      case 'cableM': return figure(m.cableM);
      case 'fibreMetres': return figure(m.fibreMetres);
      case 'cost': return m.cost === null || m.cost === undefined ? '—' : figure(m.cost);
      case 'onts': return figure(m.onts);
      case 'splitters': return figure(m.splitters);
      case 'closures': return figure(m.closures);
      case 'worstHeadroomDb': return figure(m.worstHeadroomDb);
      case 'upstreamFailOnts': return figure(m.upstreamFailOnts);
      default: return '—';
    }
  }

  function clsFor(key: string, candidate: AutoCandidate): string {
    const m = candidate.metrics;
    if (key === 'worstHeadroomDb') return 'num' + (candidate.feasible ? '' : ' err');
    if (key === 'topology' || key === 'feasible') return '';
    if (key === 'upstreamFailOnts') {
      // A warning, not an error: the design is still offered with this count beside the ranking
      // (#185). An absent count on an older payload stays plain, because silence is not a failure.
      return isNum(m.upstreamFailOnts) && m.upstreamFailOnts > 0 ? 'num warn' : 'num';
    }
    return 'num';
  }

  /** One row, in the order `columns(objective)` answers - by construction, not by convention. */
  function cells(candidate: AutoCandidate, objective?: string | null): AutoCell[] {
    return columns(objective).map(function (column: AutoColumn): AutoCell {
      return { text: textFor(column.key, candidate), cls: clsFor(column.key, candidate) };
    });
  }

  return { columns: columns, cells: cells };
});
