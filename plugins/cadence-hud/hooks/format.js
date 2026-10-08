"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fitSegments = exports.cells = exports.attributeTurn = exports.modelsText = exports.shortModel = exports.ago = exports.lotCounts = exports.fit = exports.waveStatusFr = exports.waveSessions = exports.wavePercent = exports.commonProject = exports.lotText = exports.lotCells = exports.lotStatusFr = exports.colorOfLot = exports.limitLabel = exports.untilReset = exports.pad = exports.duration = exports.bar = exports.k = exports.colorOfPercent = void 0;
/** Couleur d'un taux d'occupation (contexte, fenêtre, budget) : vert, puis orange, puis rouge. */
var colorOfPercent = function (percent, warn, bad) {
    if (warn === void 0) { warn = 60; }
    if (bad === void 0) { bad = 85; }
    return percent === undefined ? 'subtle' : percent >= bad ? 'error' : percent >= warn ? 'warning' : 'success';
};
exports.colorOfPercent = colorOfPercent;
/** 1234 → "1k", 85 300 → "85k", 1 000 000 → "1M". */
var k = function (n) {
    if (n === undefined || !Number.isFinite(n))
        return '-';
    if (n >= 1000000)
        return "".concat((n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1), "M");
    if (n >= 1000)
        return "".concat(Math.round(n / 1000), "k");
    return String(n);
};
exports.k = k;
/** Une barre de `cells` cases, pleine à `percent`. */
var bar = function (percent, cells) {
    if (cells === void 0) { cells = 10; }
    var full = percent === undefined ? 0 : Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
    return '▰'.repeat(full) + '▱'.repeat(cells - full);
};
exports.bar = bar;
/** Durée courte : 42 s, 3 min, 1 h 05, puis en jours dès 24 h : 6 j 15 h, 3 j. */
var duration = function (ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60)
        return "".concat(s, " s");
    var m = Math.floor(s / 60);
    if (m < 60)
        return "".concat(m, " min");
    var h = Math.floor(m / 60);
    if (h < 24)
        return "".concat(h, " h ").concat(String(m % 60).padStart(2, '0'));
    var d = Math.floor(h / 24);
    return h % 24 === 0 ? "".concat(d, " j") : "".concat(d, " j ").concat(h % 24, " h");
};
exports.duration = duration;
/** Complète à `width` cellules (pour aligner une colonne). */
var pad = function (text, width) { return text.padEnd(width); };
exports.pad = pad;
/** Temps avant une date ISO ("↻ 2 h 10"), ou vide si inconnue ou passée. */
var untilReset = function (iso, now) {
    if (!iso)
        return '';
    var t = Date.parse(iso);
    if (!Number.isFinite(t) || t <= now)
        return '';
    return "\u21BB ".concat((0, exports.duration)(t - now));
};
exports.untilReset = untilReset;
var limitLabel = function (kind) {
    return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7j' : kind === 'spend_limit' ? 'EUR' : kind;
};
exports.limitLabel = limitLabel;
/** Couleur d'un lot orchestré selon son statut. */
var colorOfLot = function (status) {
    switch (status) {
        case 'ready':
            return 'success';
        case 'failed':
        case 'handed-back':
            return 'error';
        case 'question':
        case 'suspended':
            return 'warning';
        case 'queued':
            return 'subtle';
        default:
            return 'claude';
    }
};
exports.colorOfLot = colorOfLot;
var STATUS_FR = {
    queued: 'en attente',
    implementing: 'implémente',
    reviewing: 'relit',
    fixing: 'corrige',
    question: 'QUESTION',
    ready: 'prêt',
    'handed-back': 'rendu',
    failed: 'échec',
    suspended: 'suspendu',
};
var lotStatusFr = function (status) { var _a; return (_a = STATUS_FR[status]) !== null && _a !== void 0 ? _a : status; };
exports.lotStatusFr = lotStatusFr;
/** Les trois colonnes d'un lot : "L75" · "corrige" · "fix@sonnet 3 min +1 ✝ · p2". */
var lotCells = function (lot, now) {
    var detail = [];
    if (lot.step) {
        var since = Date.parse(lot.step.started);
        var age = Number.isFinite(since) ? " ".concat((0, exports.duration)(now - since)) : '';
        var dead = lot.step.alive ? '' : ' ✝';
        var sub = lot.step.sub > 0 ? " +".concat(lot.step.sub) : '';
        detail.push("".concat(lot.step.kind, "@").concat(lot.step.model).concat(age).concat(sub).concat(dead));
    }
    else if (lot.next && lot.status !== 'ready') {
        detail.push("\u2192 ".concat(lot.next));
    }
    if (lot.pass > 0)
        detail.push("p".concat(lot.pass));
    return { lot: lot.lot, status: (0, exports.lotStatusFr)(lot.status), detail: detail.join(' · ') };
};
exports.lotCells = lotCells;
/** "L75 corrige · fix@sonnet 3 min" — les cellules sur une ligne. */
var lotText = function (lot, now) {
    var c = (0, exports.lotCells)(lot, now);
    return ["".concat(c.lot, " ").concat(c.status), c.detail].filter(Boolean).join(' · ');
};
exports.lotText = lotText;
/** Le projet commun à tous les lots d'une vague, ou null s'ils en ont plusieurs. */
var commonProject = function (wave) {
    var projects = new Set(wave.lots.map(function (l) { return l.project; }));
    return projects.size === 1 ? __spreadArray([], projects, true)[0] : null;
};
exports.commonProject = commonProject;
var wavePercent = function (wave) {
    return wave.budget && wave.consumed !== undefined ? Math.round((100 * wave.consumed) / wave.budget) : undefined;
};
exports.wavePercent = wavePercent;
var waveSessions = function (wave) { return wave.lots.filter(function (l) { var _a; return (_a = l.step) === null || _a === void 0 ? void 0 : _a.alive; }).length; };
exports.waveSessions = waveSessions;
var waveStatusFr = function (status) {
    switch (status) {
        case 'running':
            return 'en cours';
        case 'suspended-budget':
            return 'suspendue (budget)';
        case 'suspended-quota':
            return 'suspendue (quota)';
        case 'done':
            return 'terminée';
        case 'interrupted':
            return 'interrompue';
        default:
            return status !== null && status !== void 0 ? status : '?';
    }
};
exports.waveStatusFr = waveStatusFr;
/** Tronque à `width` caractères, avec trois points ASCII (« … » est de largeur ambiguë, que cells() ne couvre pas). */
var fit = function (text, width) {
    return width <= 2 ? '' : text.length <= width ? text : "".concat(text.slice(0, Math.max(0, width - 3)), "...");
};
exports.fit = fit;
var STATUS_PLURAL_FR = {
    queued: 'en attente',
    question: 'questions',
    ready: 'prêts',
    'handed-back': 'rendus',
    failed: 'échecs',
    suspended: 'suspendus',
};
/** Le bilan des lots d'une vague : "3 prêts · 1 échec · 3 suspendus", dans l'ordre prêt, échec, rendu, question, suspendu, reste. */
var lotCounts = function (wave) {
    var _a;
    var order = ['ready', 'failed', 'handed-back', 'question', 'suspended'];
    var counts = new Map();
    for (var _i = 0, _b = wave.lots; _i < _b.length; _i++) {
        var lot = _b[_i];
        counts.set(lot.status, ((_a = counts.get(lot.status)) !== null && _a !== void 0 ? _a : 0) + 1);
    }
    var statuses = __spreadArray([], counts.keys(), true).sort(function (a, b) {
        var ia = order.indexOf(a);
        var ib = order.indexOf(b);
        return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
    });
    return statuses
        .map(function (s) {
        var _a;
        var n = counts.get(s);
        return "".concat(n, " ").concat(n > 1 ? ((_a = STATUS_PLURAL_FR[s]) !== null && _a !== void 0 ? _a : (0, exports.lotStatusFr)(s)) : (0, exports.lotStatusFr)(s));
    })
        .join(' · ');
};
exports.lotCounts = lotCounts;
/** "il y a 12 min" depuis une date ISO, ou vide si inconnue. */
var ago = function (iso, now) {
    if (!iso)
        return '';
    var t = Date.parse(iso);
    if (!Number.isFinite(t))
        return '';
    return "il y a ".concat((0, exports.duration)(Math.max(0, now - t)));
};
exports.ago = ago;
/** Le nom court d'un identifiant de modèle : `claude-fable-5-1` → `fable`, `claude-sonnet-5-5` → `sonnet`, autre → l'identifiant. */
var shortModel = function (id) {
    var m = /^(?:[a-z0-9]+\.)?(?:anthropic\.)?claude-([a-z]+)/i.exec(id);
    return m ? m[1].toLowerCase() : id;
};
exports.shortModel = shortModel;
/** "fable 410k $0.95 | sonnet 85k $0.12", du plus cher au moins cher ; vide sans modèle. */
var modelsText = function (models) {
    return Object.entries(models.byModel)
        .sort(function (_a, _b) {
        var a = _a[1];
        var b = _b[1];
        return b.usd - a.usd || b.tokens - a.tokens;
    })
        .map(function (_a) {
        var name = _a[0], m = _a[1];
        return "".concat(name, " ").concat((0, exports.k)(m.tokens), " $").concat(m.usd.toFixed(2));
    })
        .join(' | ');
};
exports.modelsText = modelsText;
/** Un tour fini attribue ses tokens au modèle `name` et la part du coût de session apparue depuis le dernier tour :
 *  `total` est le coût courant de /cost (undefined quand il n'a pu être lu) ; un total absent, inchangé ou plus bas
 *  ne répartit rien, jamais de part négative, et la somme des parts reste égale au dernier total vu. */
var attributeTurn = function (m, name, tokens, total) {
    var _a;
    var _b;
    var seen = total !== undefined && total > m.usdSeen ? total : m.usdSeen;
    var usd = seen - m.usdSeen;
    var before = (_b = m.byModel[name]) !== null && _b !== void 0 ? _b : { tokens: 0, usd: 0 };
    return { byModel: __assign(__assign({}, m.byModel), (_a = {}, _a[name] = { tokens: before.tokens + tokens, usd: before.usd + usd }, _a)), usdSeen: seen };
};
exports.attributeTurn = attributeTurn;
/**
 * Largeur en cellules terminal, au pire cas (la première ligne de la bande n'emploie que de l'ASCII et ces symboles) : les caractères de largeur ambiguë (formes géométriques ▰▱, symboles ⚙,
 * traits │, flèches ↻) comptent pour 2, comme dans un terminal réglé en ambiguous-width=2, et les caractères larges
 * (CJK, emoji) aussi. Un terminal en largeur 1 n'affiche alors jamais plus que ce que la mesure a prévu.
 */
var cells = function (text) {
    var n = 0;
    for (var _i = 0, text_1 = text; _i < text_1.length; _i++) {
        var ch = text_1[_i];
        var c = ch.codePointAt(0);
        var isWide = (c >= 0x2190 && c <= 0x21ff) || // flèches
            (c >= 0x2500 && c <= 0x27bf) || // traits, blocs, formes géométriques, symboles, dingbats
            (c >= 0x1100 && c <= 0x115f) ||
            (c >= 0x2e80 && c <= 0xa4cf) ||
            (c >= 0xac00 && c <= 0xd7a3) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xfe30 && c <= 0xfe6f) ||
            (c >= 0xff00 && c <= 0xff60) ||
            (c >= 0xffe0 && c <= 0xffe6) ||
            c >= 0x1f300;
        n += isWide ? 2 : 1;
    }
    return n;
};
exports.cells = cells;
/**
 * Garde les segments d'une ligne qui tiennent dans `width` cellules : tant que la somme des textes dépasse, le
 * segment au `drop` le plus haut tombe (0 = ne tombe jamais). Puis, une fois le compte bon, les segments tombés
 * qui tiendraient dans la place restante reviennent, du plus utile (`drop` le plus bas) au moins utile : un gros
 * segment tombé ne prive pas la ligne des petits qui entrent. Un segment qui `requires` la clé d'un autre ne
 * revient que si celui-là est gardé. Les textes sont mesurés par `cells`. Rend les segments gardés, dans leur ordre.
 */
var fitSegments = function (segments, width) {
    var kept = new Set(segments);
    var length = function () { return __spreadArray([], kept, true).reduce(function (n, s) { return n + (0, exports.cells)(s.text); }, 0); };
    while (length() > width) {
        var idx = void 0;
        for (var _i = 0, segments_1 = segments; _i < segments_1.length; _i++) {
            var s = segments_1[_i];
            if (kept.has(s) && s.drop > 0 && (!idx || s.drop > idx.drop))
                idx = s;
        }
        if (!idx)
            break;
        kept.delete(idx);
    }
    var free = width - length();
    var dropped = segments.filter(function (s) { return !kept.has(s); }).sort(function (a, b) { return a.drop - b.drop; });
    var _loop_1 = function (s) {
        var needed = (0, exports.cells)(s.text);
        var parent_1 = s.requires === undefined || segments.some(function (o) { return kept.has(o) && o.key === s.requires; });
        if (parent_1 && needed <= free) {
            kept.add(s);
            free -= needed;
        }
    };
    for (var _a = 0, dropped_1 = dropped; _a < dropped_1.length; _a++) {
        var s = dropped_1[_a];
        _loop_1(s);
    }
    return segments.filter(function (s) { return kept.has(s); });
};
exports.fitSegments = fitSegments;
