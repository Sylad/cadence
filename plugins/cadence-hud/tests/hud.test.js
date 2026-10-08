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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var testing_1 = require("claude-code/testing");
var collect_1 = require("../hooks/collect");
var format_1 = require("../hooks/format");
var PLUGIN = 'cadence-hud';
var BAND = {
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
};
var WAVE = {
    id: '2026-10-07-2103',
    pid: 1,
    cwd: '/x',
    cap: 2,
    started: '2026-10-07T19:03:10.939Z',
    status: 'running',
    live: true,
    budget: 1000000,
    consumed: 81926,
    lots: [
        {
            project: 'cadence',
            lot: 'L75',
            title: 'raf show aligne les lignes suivantes d’une note',
            status: 'fixing',
            pass: 0,
            model: 'sonnet',
            next: 'fix',
            steps: 3,
            step: { kind: 'fix', model: 'sonnet', started: '2026-10-07T19:11:11.066Z', pid: 2, alive: true, sub: 0 },
        },
        { project: 'cadence', lot: 'L110', title: 'un lot en attente', status: 'queued', pass: 0, model: 'sonnet', next: null, steps: 0, step: null },
    ],
};
(0, testing_1.test)('les couleurs suivent les seuils', function () {
    (0, testing_1.expect)((0, format_1.colorOfPercent)(undefined)).toBe('subtle');
    (0, testing_1.expect)((0, format_1.colorOfPercent)(10)).toBe('success');
    (0, testing_1.expect)((0, format_1.colorOfPercent)(70)).toBe('warning');
    (0, testing_1.expect)((0, format_1.colorOfPercent)(90)).toBe('error');
    (0, testing_1.expect)((0, format_1.colorOfPercent)(60, 50, 75)).toBe('warning');
    (0, testing_1.expect)((0, format_1.colorOfLot)('ready')).toBe('success');
    (0, testing_1.expect)((0, format_1.colorOfLot)('failed')).toBe('error');
    (0, testing_1.expect)((0, format_1.colorOfLot)('question')).toBe('warning');
    (0, testing_1.expect)((0, format_1.colorOfLot)('queued')).toBe('subtle');
    (0, testing_1.expect)((0, format_1.colorOfLot)('fixing')).toBe('claude');
});
(0, testing_1.test)('les nombres, barres et durées sont courts', function () {
    (0, testing_1.expect)((0, format_1.k)(85300)).toBe('85k');
    (0, testing_1.expect)((0, format_1.k)(1000000)).toBe('1M');
    (0, testing_1.expect)((0, format_1.k)(1500000)).toBe('1.5M');
    (0, testing_1.expect)((0, format_1.k)(undefined)).toBe('-');
    (0, testing_1.expect)((0, format_1.bar)(0)).toBe('▱▱▱▱▱▱▱▱▱▱');
    (0, testing_1.expect)((0, format_1.bar)(50)).toBe('▰▰▰▰▰▱▱▱▱▱');
    (0, testing_1.expect)((0, format_1.bar)(100)).toBe('▰▰▰▰▰▰▰▰▰▰');
    (0, testing_1.expect)((0, format_1.duration)(42000)).toBe('42 s');
    (0, testing_1.expect)((0, format_1.duration)(3 * 60000)).toBe('3 min');
    (0, testing_1.expect)((0, format_1.duration)(65 * 60000)).toBe('1 h 05');
    (0, testing_1.expect)((0, format_1.duration)(23 * 3600000 + 59 * 60000)).toBe('23 h 59');
    (0, testing_1.expect)((0, format_1.duration)(159 * 3600000 + 28 * 60000)).toBe('6 j 15 h');
    (0, testing_1.expect)((0, format_1.duration)(72 * 3600000)).toBe('3 j');
});
(0, testing_1.test)('un lot se lit en trois cellules ou en une ligne', function () {
    var at = Date.parse('2026-10-07T19:14:11.066Z');
    (0, testing_1.expect)((0, format_1.lotCells)(WAVE.lots[0], at)).toEqual({ lot: 'L75', status: 'corrige', detail: 'fix@sonnet 3 min' });
    (0, testing_1.expect)((0, format_1.lotCells)(WAVE.lots[1], at)).toEqual({ lot: 'L110', status: 'en attente', detail: '' });
    (0, testing_1.expect)((0, format_1.lotText)(WAVE.lots[0], at)).toBe('L75 corrige · fix@sonnet 3 min');
    (0, testing_1.expect)((0, format_1.lotText)(WAVE.lots[1], at)).toBe('L110 en attente');
    (0, testing_1.expect)((0, format_1.wavePercent)(WAVE)).toBe(8);
    (0, testing_1.expect)((0, format_1.commonProject)(WAVE)).toBe('cadence');
    (0, testing_1.expect)((0, format_1.commonProject)(__assign(__assign({}, WAVE), { lots: [WAVE.lots[0], __assign(__assign({}, WAVE.lots[1]), { project: 'maritime' })] }))).toBeNull();
});
(0, testing_1.test)('le collecteur se lit, et une sortie étrange vaut aucune vague', function () {
    var _a, _b, _c;
    (0, testing_1.expect)((_a = (0, collect_1.parseWaves)(JSON.stringify([WAVE]))[0]) === null || _a === void 0 ? void 0 : _a.id).toBe(WAVE.id);
    (0, testing_1.expect)((_b = (0, collect_1.parseWaves)(JSON.stringify([__assign(__assign({}, WAVE), { live: undefined })]))[0]) === null || _b === void 0 ? void 0 : _b.live).toBe(true);
    (0, testing_1.expect)((_c = (0, collect_1.parseWaves)(JSON.stringify([__assign(__assign({}, WAVE), { live: false })]))[0]) === null || _c === void 0 ? void 0 : _c.live).toBe(false);
    (0, testing_1.expect)((0, collect_1.parseWaves)('{}')).toEqual([]);
    (0, testing_1.expect)(function () { return (0, collect_1.parseWaves)('pas du json'); }).toThrow();
});
/** Répond aux lectures d'état du mod depuis la mémoire du test (le kit n'a pas d'écriture d'état). */
var seed = function (on, values) {
    return on('state.get', function (_$, e, next) {
        return e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e);
    });
};
var EMPTY = { agents: { running: 0, names: [] }, models: { byModel: {}, usdSeen: 0 }, error: null, isHidden: false };
(0, testing_1.test)('la bande dessine le contexte et la vague sur chaque surface', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var _i, _a, surface, ui, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    return __generator(this, function (_m) {
        switch (_m.label) {
            case 0:
                seed(on, __assign(__assign({}, EMPTY), { usage: {
                        percent: 42,
                        tokens: 84000,
                        window: 200000,
                        usd: 1.23,
                        limits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-07T23:00:00Z' }],
                    }, waves: [WAVE], now: Date.parse('2026-10-07T19:14:11.066Z') }));
                _i = 0, _a = ['terminal', 'desktop'];
                _m.label = 1;
            case 1:
                if (!(_i < _a.length)) return [3 /*break*/, 15];
                surface = _a[_i];
                return [4 /*yield*/, $.ui.mount(__assign({ plugin: PLUGIN, surface: surface }, BAND))];
            case 2:
                ui = _m.sent();
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /42 %/ })];
            case 3:
                _b.apply(void 0, [_m.sent()]).toBeDefined();
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /5h/ })];
            case 4:
                _c.apply(void 0, [_m.sent()]).toBeDefined();
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /cadence · 2026-10-07-2103 en cours/ })];
            case 5:
                _d.apply(void 0, [_m.sent()]).toBeDefined();
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^L75$/ })];
            case 6:
                _e.apply(void 0, [_m.sent()]).toBeDefined();
                _f = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^corrige\s*$/ })];
            case 7:
                _f.apply(void 0, [_m.sent()]).toBeDefined();
                _g = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /fix@sonnet 3 min/ })];
            case 8:
                _g.apply(void 0, [_m.sent()]).toBeDefined();
                _h = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /raf show aligne les lignes/ })];
            case 9:
                _h.apply(void 0, [_m.sent()]).toBeDefined();
                _j = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /un lot en attente/ })];
            case 10:
                _j.apply(void 0, [_m.sent()]).toBeUndefined();
                _k = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^en attente$/ })];
            case 11:
                _k.apply(void 0, [_m.sent()]).toBeDefined();
                _l = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^L110$/ })];
            case 12:
                _l.apply(void 0, [_m.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 13:
                _m.sent();
                _m.label = 14;
            case 14:
                _i++;
                return [3 /*break*/, 1];
            case 15: return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('masquée, la bande laisse la main', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var ui, _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                seed(on, __assign(__assign({}, EMPTY), { isHidden: true, usage: { percent: 42, window: 200000, limits: [] }, waves: [], now: 0 }));
                on('ui.render', { component: 'AbovePrompt' }, function ($, e) {
                    var Text = $.ui.resolve(e).Text;
                    return <Text key="engine">la bande du moteur</Text>;
                });
                return [4 /*yield*/, $.ui.mount(__assign({ plugin: PLUGIN, surface: 'terminal' }, BAND))];
            case 1:
                ui = _c.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /ctx/ })];
            case 2:
                _a.apply(void 0, [_c.sent()]).toBeUndefined();
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /moteur/ })];
            case 3:
                _b.apply(void 0, [_c.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 4:
                _c.sent();
                return [2 /*return*/];
        }
    });
}); });
var ENDED = __assign(__assign({}, WAVE), { id: '2026-10-07-2131', status: 'interrupted', live: false, ended: '2026-10-07T19:51:25.831Z', budget: 2000000, consumed: 440181, lots: [
        __assign(__assign({}, WAVE.lots[0]), { lot: 'L107', status: 'ready', step: null }),
        __assign(__assign({}, WAVE.lots[0]), { lot: 'L112', status: 'ready', step: null }),
        __assign(__assign({}, WAVE.lots[0]), { lot: 'L106', status: 'failed', step: null }),
        __assign(__assign({}, WAVE.lots[1]), { lot: 'L113', status: 'suspended' }),
    ] });
(0, testing_1.test)('le bilan des lots et l’ancienneté se lisent', function () {
    (0, testing_1.expect)((0, format_1.lotCounts)(ENDED)).toBe('2 prêts · 1 échec · 1 suspendu');
    (0, testing_1.expect)((0, format_1.lotCounts)(__assign(__assign({}, ENDED), { lots: [] }))).toBe('');
    (0, testing_1.expect)((0, format_1.ago)(ENDED.ended, Date.parse('2026-10-07T20:03:25.831Z'))).toBe('il y a 12 min');
    (0, testing_1.expect)((0, format_1.ago)(undefined, 0)).toBe('');
});
(0, testing_1.test)('la dernière vague terminée reste en gris, sur une ligne, sans ses lots', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var ui, _a, _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0:
                seed(on, __assign(__assign({}, EMPTY), { usage: { percent: 9, tokens: 90000, window: 1000000, limits: [] }, waves: [ENDED], now: Date.parse('2026-10-07T20:03:25.831Z') }));
                return [4 /*yield*/, $.ui.mount(__assign({ plugin: PLUGIN, surface: 'desktop' }, BAND))];
            case 1:
                ui = _f.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /cadence · 2026-10-07-2131 interrompue il y a 12 min/ })];
            case 2:
                _a.apply(void 0, [_f.sent()]).toBeDefined();
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /budget\s+22 % 440k\/2M/ })];
            case 3:
                _b.apply(void 0, [_f.sent()]).toBeDefined();
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /2 prêts · 1 échec · 1 suspendu/ })];
            case 4:
                _c.apply(void 0, [_f.sent()]).toBeDefined();
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^L107$/ })];
            case 5:
                _d.apply(void 0, [_f.sent()]).toBeUndefined();
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /session/ })];
            case 6:
                _e.apply(void 0, [_f.sent()]).toBeUndefined();
                return [4 /*yield*/, ui.unmount()];
            case 7:
                _f.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('la consommation par modèle se lit, du plus cher au moins cher', function () {
    (0, testing_1.expect)((0, format_1.shortModel)('claude-fable-5-1')).toBe('fable');
    (0, testing_1.expect)((0, format_1.shortModel)('claude-sonnet-5-5')).toBe('sonnet');
    (0, testing_1.expect)((0, format_1.shortModel)('us.anthropic.claude-opus-5-5-v1:0')).toBe('opus');
    (0, testing_1.expect)((0, format_1.shortModel)('gpt-x')).toBe('gpt-x');
    (0, testing_1.expect)((0, format_1.modelsText)({ byModel: { sonnet: { tokens: 85300, usd: 0.12 }, fable: { tokens: 410000, usd: 0.95 } }, usdSeen: 1.07 })).toBe('fable 410k $0.95 | sonnet 85k $0.12');
    (0, testing_1.expect)((0, format_1.modelsText)({ byModel: {}, usdSeen: 0 })).toBe('');
});
(0, testing_1.test)('la bande montre la part de chaque modèle à côté du coût', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var ui, _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                seed(on, __assign(__assign({}, EMPTY), { usage: { percent: 9, tokens: 90000, window: 1000000, usd: 1.07, limits: [] }, models: { byModel: { fable: { tokens: 410000, usd: 0.95 }, sonnet: { tokens: 85300, usd: 0.12 } }, usdSeen: 1.07 }, waves: [], now: 0 }));
                return [4 /*yield*/, $.ui.mount(__assign({ plugin: PLUGIN, surface: 'terminal' }, BAND))];
            case 1:
                ui = _b.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /fable 410k \$0\.95 \| sonnet 85k \$0\.12/ })];
            case 2:
                _a.apply(void 0, [_b.sent()]).toBeDefined();
                return [4 /*yield*/, ui.unmount()];
            case 3:
                _b.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('l’attribution par tour : premier tour, total inconnu, inchangé ou plus bas, et la somme des parts vaut le total', function () {
    var m = (0, format_1.attributeTurn)({ byModel: {}, usdSeen: 0 }, 'fable', 1000, 0.5);
    var of = function (name) { var _a; return (_a = m.byModel[name]) !== null && _a !== void 0 ? _a : { tokens: NaN, usd: NaN }; };
    (0, testing_1.expect)(of('fable').tokens).toBe(1000);
    (0, testing_1.expect)(of('fable').usd).toBe(0.5);
    (0, testing_1.expect)(m.usdSeen).toBe(0.5);
    m = (0, format_1.attributeTurn)(m, 'sonnet', 200, undefined); // usage() en échec : les tokens comptent, rien n'est réparti
    (0, testing_1.expect)(of('sonnet').tokens).toBe(200);
    (0, testing_1.expect)(of('sonnet').usd).toBe(0);
    (0, testing_1.expect)(m.usdSeen).toBe(0.5);
    m = (0, format_1.attributeTurn)(m, 'sonnet', 300, 0.5); // total inchangé
    (0, testing_1.expect)(of('sonnet').tokens).toBe(500);
    (0, testing_1.expect)(of('sonnet').usd).toBe(0);
    m = (0, format_1.attributeTurn)(m, 'fable', 100, 0.4); // total plus bas : jamais de part négative
    (0, testing_1.expect)(of('fable').usd).toBe(0.5);
    (0, testing_1.expect)(m.usdSeen).toBe(0.5);
    m = (0, format_1.attributeTurn)(m, 'sonnet', 100, 0.8);
    var sum = Object.values(m.byModel).reduce(function (a, s) { return a + s.usd; }, 0);
    (0, testing_1.expect)(Math.abs(sum - 0.8) < 1e-9).toBe(true);
    (0, testing_1.expect)(m.usdSeen).toBe(0.8);
});
(0, testing_1.test)('les segments tombent par priorité jusqu’à tenir dans la largeur', function () {
    var segs = [
        { key: 'ctx', text: 'ctx 1234567890', drop: 0 },
        { key: '5h', text: ' | 5h 12 %', drop: 1 },
        { key: 'usd', text: ' | $1.31', drop: 3 },
        { key: 'models', text: ' | fable 416k $1.47', drop: 5 },
    ];
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 200).map(function (s) { return s.key; })).toEqual(['ctx', '5h', 'usd', 'models']);
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 40).map(function (s) { return s.key; })).toEqual(['ctx', '5h', 'usd']);
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 20).map(function (s) { return s.key; })).toEqual(['ctx']);
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 5).map(function (s) { return s.key; })).toEqual(['ctx']);
});
(0, testing_1.test)('fitSegments reprend les petits segments qui tiennent une fois le gros tombé (cas de la capture du 08-10)', function () {
    var segs = [
        { key: 'ctx', text: 'c'.repeat(30), drop: 0 },
        { key: '5h', text: ' | 5h 12 %', drop: 1 },
        { key: '5h-reset', text: ' r 1 h 10', drop: 5, requires: '5h' },
        { key: 'usd', text: ' | $1.31', drop: 3 },
        { key: 'models', text: " | ".concat('m'.repeat(40)), drop: 4 },
    ];
    // tout = 30 + 10 + 9 + 8 + 43 = 100 ; sans modèles = 57 : à 70 cellules, les modèles ne tiennent pas mais le reste oui
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 70).map(function (s) { return s.key; })).toEqual(['ctx', '5h', '5h-reset', 'usd']);
    // 50 : ni les modèles (43) ni la remise à zéro (9) ne rentrent dans les 2 cellules qui restent avec le coût
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 50).map(function (s) { return s.key; })).toEqual(['ctx', '5h', 'usd']);
    // 57 : juste de quoi reprendre la remise à zéro (48 + 9), pas les modèles
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 57).map(function (s) { return s.key; })).toEqual(['ctx', '5h', '5h-reset', 'usd']);
    // un segment qui `requires` un segment tombé ne revient pas seul
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 35).map(function (s) { return s.key; })).toEqual(['ctx']);
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 41).map(function (s) { return s.key; })).toEqual(['ctx', '5h']);
});
(0, testing_1.test)('cells compte en pire cas les caractères de largeur ambiguë (▰▱⚙│↻) et les larges pour 2 cellules', function () {
    (0, testing_1.expect)((0, format_1.cells)('abc')).toBe(3);
    (0, testing_1.expect)((0, format_1.cells)('▰▰▱')).toBe(6);
    (0, testing_1.expect)((0, format_1.cells)('⚙ 2')).toBe(4);
    (0, testing_1.expect)((0, format_1.cells)('  │  ')).toBe(6);
    (0, testing_1.expect)((0, format_1.cells)('↻ 2 h')).toBe(6);
    (0, testing_1.expect)((0, format_1.cells)('日本')).toBe(4);
    (0, testing_1.expect)((0, format_1.cells)('éa')).toBe(2);
});
(0, testing_1.test)('fitSegments mesure en cellules : une barre ▰▱ de 10 cases pèse 20 cellules', function () {
    var segs = [
        { key: 'ctx', text: "ctx ".concat((0, format_1.bar)(50)), drop: 0 },
        { key: 'agents', text: '  │  ⚙ 2 agents', drop: 2 },
    ];
    // 14 caractères de ctx + 14 d'agents = 28 en String.length, mais 24 + 20 = 44 cellules.
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 30).map(function (s) { return s.key; })).toEqual(['ctx']);
    (0, testing_1.expect)((0, format_1.fitSegments)(segs, 44).map(function (s) { return s.key; })).toEqual(['ctx', 'agents']);
});
(0, testing_1.test)('dans une fenêtre étroite, la première ligne lâche les modèles et les agents avant les fenêtres de quota', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var narrow, ui, _a, _b, _c, _d, _e, wide, _f, _g, _h, _j, huge, _k, _l;
    return __generator(this, function (_m) {
        switch (_m.label) {
            case 0:
                seed(on, __assign(__assign({}, EMPTY), { agents: { running: 1, names: ['tour-maritime'] }, usage: {
                        percent: 9,
                        tokens: 87000,
                        window: 1000000,
                        usd: 1.31,
                        limits: [
                            { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-10-08T05:00:00Z' },
                            { kind: 'seven_day', percentUsed: 6, resetsAt: '2026-10-14T05:00:00Z' },
                        ],
                    }, models: { byModel: { fable: { tokens: 416000, usd: 1.47 }, haiku: { tokens: 190000, usd: 0.03 } }, usdSeen: 1.5 }, waves: [], now: Date.parse('2026-10-08T00:11:00Z') }));
                narrow = __assign(__assign({}, BAND), { props: __assign(__assign({}, BAND.props), { bodyColumns: 70 }) });
                return [4 /*yield*/, $.ui.mount(__assign({ plugin: PLUGIN, surface: 'desktop' }, narrow))];
            case 1:
                ui = _m.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /87k\/1M/ })];
            case 2:
                _a.apply(void 0, [_m.sent()]).toBeDefined();
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^5h $/ })];
            case 3:
                _b.apply(void 0, [_m.sent()]).toBeDefined();
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /^7j $/ })];
            case 4:
                _c.apply(void 0, [_m.sent()]).toBeDefined();
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /fable/ })];
            case 5:
                _d.apply(void 0, [_m.sent()]).toBeUndefined();
                _e = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /tour-maritime/ })];
            case 6:
                _e.apply(void 0, [_m.sent()]).toBeUndefined();
                return [4 /*yield*/, ui.unmount()
                    // 140 colonnes (mesurées en cellules, ▰▱⚙│ comptés double) : les modèles passent avant les heures de remise à
                    // zéro, les noms d'agents tombent encore
                ];
            case 7:
                _m.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({ plugin: PLUGIN, surface: 'desktop' }, BAND), { props: __assign(__assign({}, BAND.props), { bodyColumns: 140 }) }))];
            case 8:
                wide = _m.sent();
                _f = testing_1.expect;
                return [4 /*yield*/, wide.find({ type: 'Text', text: /fable 416k \$1\.47 \| haiku 190k \$0\.03/ })];
            case 9:
                _f.apply(void 0, [_m.sent()]).toBeDefined();
                _g = testing_1.expect;
                return [4 /*yield*/, wide.find({ type: 'Text', text: /↻/ })];
            case 10:
                _g.apply(void 0, [_m.sent()]).toBeUndefined();
                _h = testing_1.expect;
                return [4 /*yield*/, wide.find({ type: 'Text', text: /⚙ 1 agent/ })];
            case 11:
                _h.apply(void 0, [_m.sent()]).toBeDefined();
                _j = testing_1.expect;
                return [4 /*yield*/, wide.find({ type: 'Text', text: /tour-maritime/ })];
            case 12:
                _j.apply(void 0, [_m.sent()]).toBeUndefined();
                return [4 /*yield*/, wide.unmount()];
            case 13:
                _m.sent();
                return [4 /*yield*/, $.ui.mount(__assign(__assign({ plugin: PLUGIN, surface: 'desktop' }, BAND), { props: __assign(__assign({}, BAND.props), { bodyColumns: 200 }) }))];
            case 14:
                huge = _m.sent();
                _k = testing_1.expect;
                return [4 /*yield*/, huge.find({ type: 'Text', text: /↻ 4 h 49/ })];
            case 15:
                _k.apply(void 0, [_m.sent()]).toBeDefined();
                _l = testing_1.expect;
                return [4 /*yield*/, huge.find({ type: 'Text', text: /tour-maritime/ })];
            case 16:
                _l.apply(void 0, [_m.sent()]).toBeDefined();
                return [4 /*yield*/, huge.unmount()];
            case 17:
                _m.sent();
                return [2 /*return*/];
        }
    });
}); });
(0, testing_1.test)('fit coupe avec trois points ASCII, sans dépasser la largeur', function () {
    (0, testing_1.expect)((0, format_1.fit)('abcdefghij', 10)).toBe('abcdefghij');
    (0, testing_1.expect)((0, format_1.fit)('abcdefghij', 8)).toBe('abcde...');
    (0, testing_1.expect)((0, format_1.fit)('abcdefghij', 3)).toBe('...');
    (0, testing_1.expect)((0, format_1.fit)('abcdefghij', 2)).toBe('');
});
(0, testing_1.test)('la première ligne n\'emploie que de l\'ASCII et les symboles que cells() sait compter (▰▱⚙│↻)', function ($, on) { return __awaiter(void 0, void 0, void 0, function () {
    var ui, _a, _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0:
                seed(on, __assign(__assign({}, EMPTY), { agents: { running: 2, names: ['un-nom-d-agent-tres-long', 'un-autre-nom-d-agent-tres-long', 'et-encore-un-troisieme'] }, usage: {
                        percent: undefined,
                        tokens: undefined,
                        window: undefined,
                        usd: 1.31,
                        limits: [
                            { kind: 'five_hour', percentUsed: undefined, resetsAt: '2026-10-08T05:00:00Z' },
                            { kind: 'seven_day', percentUsed: 6, resetsAt: '2026-10-14T05:00:00Z' },
                            { kind: 'spend_limit', percentUsed: 12, resetsAt: '2026-10-14T05:00:00Z' },
                        ],
                    }, models: {
                        byModel: {
                            'un-modele-au-nom-tres-long-1': { tokens: 416000, usd: 1.47 },
                            'un-modele-au-nom-tres-long-2': { tokens: 190000, usd: 0.03 },
                        },
                        usdSeen: 1.5,
                    }, waves: [], now: Date.parse('2026-10-08T00:11:00Z') }));
                return [4 /*yield*/, $.ui.mount(__assign(__assign({ plugin: PLUGIN, surface: 'desktop' }, BAND), { props: __assign(__assign({}, BAND.props), { bodyColumns: 400 }) }))];
            case 1:
                ui = _e.sent();
                _a = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /↻ \d/ })];
            case 2:
                _a.apply(void 0, [_e.sent()]).toBeDefined();
                _b = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /\.\.\./ })];
            case 3:
                _b.apply(void 0, [_e.sent()]).toBeDefined();
                _c = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /EUR/ })];
            case 4:
                _c.apply(void 0, [_e.sent()]).toBeDefined();
                _d = testing_1.expect;
                return [4 /*yield*/, ui.find({ type: 'Text', text: /[^\x00-\x7f▰▱⚙│↻]/ })];
            case 5:
                _d.apply(void 0, [_e.sent()]).toBeUndefined();
                return [4 /*yield*/, ui.unmount()];
            case 6:
                _e.sent();
                return [2 /*return*/];
        }
    });
}); });
