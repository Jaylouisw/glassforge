"use strict";
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else if (root)
        root.GFAuto = api;
})(typeof self !== 'undefined' ? self : undefined, function () {
    'use strict';
    const LABELS = {
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
    const HINTS = {
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
    function columns(objective) {
        const keys = ['topology', 'feasible', 'cableM', 'fibreMetres'];
        if (objective === 'cost')
            keys.push('cost');
        keys.push('onts', 'splitters', 'closures', 'worstHeadroomDb', 'upstreamFailOnts');
        return keys.map(function (key) {
            return { key: key, label: LABELS[key], hint: HINTS[key] || null };
        });
    }
    function isNum(value) {
        return typeof value === 'number' && isFinite(value);
    }
    /** An absent figure is a dash, never a zero: "no figure" and "nothing" are not one answer. */
    function figure(value) {
        return isNum(value) ? String(value) : '—';
    }
    function textFor(key, candidate) {
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
    function clsFor(key, candidate) {
        const m = candidate.metrics;
        if (key === 'worstHeadroomDb')
            return 'num' + (candidate.feasible ? '' : ' err');
        if (key === 'topology' || key === 'feasible')
            return '';
        if (key === 'upstreamFailOnts') {
            // A warning, not an error: the design is still offered with this count beside the ranking
            // (#185). An absent count on an older payload stays plain, because silence is not a failure.
            return isNum(m.upstreamFailOnts) && m.upstreamFailOnts > 0 ? 'num warn' : 'num';
        }
        return 'num';
    }
    /** One row, in the order `columns(objective)` answers - by construction, not by convention. */
    function cells(candidate, objective) {
        return columns(objective).map(function (column) {
            return { text: textFor(column.key, candidate), cls: clsFor(column.key, candidate) };
        });
    }
    return { columns: columns, cells: cells };
});
