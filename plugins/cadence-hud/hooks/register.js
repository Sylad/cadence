"use strict";
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
exports.register = void 0;
var claude_code_1 = require("claude-code");
var collect_1 = require("./collect");
var format_1 = require("./format");
var PLUGIN = 'cadence-hud';
var REFRESH_MS = 5000;
var usage = (0, claude_code_1.atom)({ plugin: 'cadence-hud', key: 'usage' }, null);
var agents = (0, claude_code_1.atom)({ plugin: 'cadence-hud', key: 'agents' }, { running: 0, names: [] });
var models = (0, claude_code_1.atom)({ plugin: 'cadence-hud', key: 'models' }, { byModel: {}, usdSeen: 0 });
var waves = (0, claude_code_1.atom)({ plugin: 'cadence-hud', key: 'waves' }, []);
var error = (0, claude_code_1.atom)({ plugin: 'cadence-hud', key: 'error' }, null);
var isHidden = (0, claude_code_1.atom)({ plugin: 'cadence-hud', key: 'isHidden' }, false);
var now = (0, claude_code_1.atom)({ plugin: 'cadence-hud', key: 'now' }, 0);
var register = function (on) {
    var timer;
    var isRefreshing = false;
    on('session.start', function ($, e, next) { return __awaiter(void 0, void 0, void 0, function () {
        var refresh;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, $.command.register({
                        name: 'hud',
                        description: 'Affiche ou masque la bande cadence-hud (contexte, fenêtres, agents, vagues orchestrate)',
                    })];
                case 1:
                    _a.sent();
                    refresh = function () { return __awaiter(void 0, void 0, void 0, function () {
                        var _a, u, list, collected, at_1, nextUsage_1, live, summary_1, found_1, problem_1;
                        var _b, _c;
                        return __generator(this, function (_d) {
                            switch (_d.label) {
                                case 0:
                                    if (isRefreshing)
                                        return [2 /*return*/];
                                    isRefreshing = true;
                                    _d.label = 1;
                                case 1:
                                    _d.trys.push([1, , 8, 9]);
                                    return [4 /*yield*/, Promise.all([
                                            $.session.usage().catch(function () { return null; }),
                                            $.agent.list().catch(function () { return []; }),
                                            $.process.run(['python3', '-I', '-c', collect_1.COLLECTOR], { timeoutMs: 4000 }).catch(function (err) { return ({
                                                exitCode: -1,
                                                stdout: '',
                                                stderr: String(err),
                                            }); }),
                                            $.clock.now(),
                                        ])];
                                case 2:
                                    _a = _d.sent(), u = _a[0], list = _a[1], collected = _a[2], at_1 = _a[3];
                                    nextUsage_1 = u
                                        ? {
                                            percent: u.context.percent,
                                            tokens: u.context.tokens,
                                            window: u.context.window,
                                            usd: (_b = u.cost) === null || _b === void 0 ? void 0 : _b.usd,
                                            limits: u.rateLimits.map(function (r) { return ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }); }),
                                        }
                                        : null;
                                    live = list.filter(function (a) { return a.status === 'running' || a.status === 'pending' || a.status === 'waiting'; });
                                    summary_1 = {
                                        running: live.length,
                                        names: live.map(function (a) { var _a; return (_a = a.name) !== null && _a !== void 0 ? _a : a.type; }).slice(0, 4),
                                    };
                                    found_1 = [];
                                    problem_1 = null;
                                    if (collected.exitCode === 0) {
                                        try {
                                            found_1 = (0, collect_1.parseWaves)(collected.stdout);
                                        }
                                        catch (err) {
                                            problem_1 = "collecteur illisible : ".concat(String(err).slice(0, 60));
                                        }
                                    }
                                    else {
                                        problem_1 = "collecteur : ".concat((_c = (collected.stderr || "code ".concat(collected.exitCode)).trim().split('\n').pop()) === null || _c === void 0 ? void 0 : _c.slice(0, 80));
                                    }
                                    return [4 /*yield*/, (0, claude_code_1.update)($, usage, function () { return nextUsage_1; })];
                                case 3:
                                    _d.sent();
                                    return [4 /*yield*/, (0, claude_code_1.update)($, agents, function () { return summary_1; })];
                                case 4:
                                    _d.sent();
                                    return [4 /*yield*/, (0, claude_code_1.update)($, waves, function () { return found_1; })];
                                case 5:
                                    _d.sent();
                                    return [4 /*yield*/, (0, claude_code_1.update)($, error, function () { return problem_1; })];
                                case 6:
                                    _d.sent();
                                    return [4 /*yield*/, (0, claude_code_1.update)($, now, function () { return at_1; })];
                                case 7:
                                    _d.sent();
                                    return [3 /*break*/, 9];
                                case 8:
                                    isRefreshing = false;
                                    return [7 /*endfinally*/];
                                case 9: return [2 /*return*/];
                            }
                        });
                    }); };
                    timer === null || timer === void 0 ? void 0 : timer.cancel();
                    timer = $.clock.every(REFRESH_MS, function () { return void refresh(); });
                    void refresh();
                    return [2 /*return*/, next(e)];
            }
        });
    }); });
    // Chaque fin de tour (boucle principale et sous-agents) attribue ses tokens au modèle qui a répondu, et la
    // part du coût de session apparue depuis la dernière fin de tour. Deux tours qui finissent ensemble se
    // partagent le coût au mieux ; la somme des parts reste égale au total de /cost.
    on('turn.complete', function ($, e, next) { return __awaiter(void 0, void 0, void 0, function () {
        var result, used, total, name, tokens;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, next(e)];
                case 1:
                    result = _a.sent();
                    used = e.usage;
                    if (!used)
                        return [2 /*return*/, result];
                    return [4 /*yield*/, $.session
                            .usage()
                            .then(function (u) { var _a; return (_a = u.cost) === null || _a === void 0 ? void 0 : _a.usd; })
                            .catch(function () { return undefined; })];
                case 2:
                    total = _a.sent();
                    name = (0, format_1.shortModel)(used.model);
                    tokens = used.input_tokens + used.output_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens;
                    return [4 /*yield*/, (0, claude_code_1.update)($, models, function (m) { return (0, format_1.attributeTurn)(m, name, tokens, total); })];
                case 3:
                    _a.sent();
                    return [2 /*return*/, result];
            }
        });
    }); });
    on('command.run', { command: 'hud' }, function ($) { return __awaiter(void 0, void 0, void 0, function () {
        var hidden;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, claude_code_1.read)($, isHidden)];
                case 1:
                    hidden = !(_a.sent());
                    return [4 /*yield*/, (0, claude_code_1.update)($, isHidden, function () { return hidden; })];
                case 2:
                    _a.sent();
                    return [2 /*return*/, { text: hidden ? 'cadence-hud masquée (/hud pour la réafficher).' : 'cadence-hud affichée.' }];
            }
        });
    }); });
    on('ui.render', { component: 'AbovePrompt' }, function ($, e, next) { return __awaiter(void 0, void 0, void 0, function () {
        var _a, _b, u, a, m, w, problem, at, _c, Box, Text, width, sep, pct, SEP, segments, ctx, _i, _d, l, reset, usd, text, label, names, contextRow, waveRows;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    _a = e.props.hasSurvey;
                    if (_a) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, claude_code_1.read)($, isHidden)];
                case 1:
                    _a = (_e.sent());
                    _e.label = 2;
                case 2:
                    if (_a)
                        return [2 /*return*/, next(e)];
                    return [4 /*yield*/, Promise.all([
                            (0, claude_code_1.read)($, usage),
                            (0, claude_code_1.read)($, agents),
                            (0, claude_code_1.read)($, models),
                            (0, claude_code_1.read)($, waves),
                            (0, claude_code_1.read)($, error),
                            (0, claude_code_1.read)($, now),
                        ])];
                case 3:
                    _b = _e.sent(), u = _b[0], a = _b[1], m = _b[2], w = _b[3], problem = _b[4], at = _b[5];
                    if (u === null && w.length === 0 && problem === null)
                        return [2 /*return*/, next(e)];
                    _c = $.ui.resolve(e), Box = _c.Box, Text = _c.Text;
                    width = Math.max(20, e.props.bodyColumns);
                    sep = <Text dimColor>{'  │  '}</Text>;
                    pct = function (p) { return (p === undefined ? '  -' : "".concat(String(p).padStart(3), " %")); };
                    SEP = '  │  ';
                    segments = [];
                    if (u) {
                        ctx = "".concat((0, format_1.bar)(u.percent), " ").concat(pct(u.percent));
                        segments.push({
                            key: 'ctx',
                            text: "ctx ".concat(ctx, " ").concat((0, format_1.k)(u.tokens), "/").concat((0, format_1.k)(u.window)),
                            drop: 0,
                            node: (<Text key="ctx">
            <Text dimColor>ctx </Text>
            <Text color={(0, format_1.colorOfPercent)(u.percent, 50, 75)} bold>
              {ctx}
            </Text>
            <Text dimColor>
              {' '}
              {(0, format_1.k)(u.tokens)}/{(0, format_1.k)(u.window)}
            </Text>
          </Text>),
                        });
                        for (_i = 0, _d = u.limits; _i < _d.length; _i++) {
                            l = _d[_i];
                            segments.push({
                                key: l.kind,
                                text: "".concat(SEP).concat((0, format_1.limitLabel)(l.kind), " ").concat(pct(l.percentUsed)),
                                drop: 1,
                                node: (<Text key={l.kind}>
              {sep}
              <Text dimColor>{(0, format_1.limitLabel)(l.kind)} </Text>
              <Text color={(0, format_1.colorOfPercent)(l.percentUsed)} bold>
                {pct(l.percentUsed)}
              </Text>
            </Text>),
                            });
                            reset = (0, format_1.untilReset)(l.resetsAt, at);
                            if (reset) {
                                segments.push({ key: "".concat(l.kind, "-reset"), text: " ".concat(reset), drop: 5, requires: l.kind, node: <Text key={"".concat(l.kind, "-reset")} dimColor> {reset}</Text> });
                            }
                        }
                        if (u.usd !== undefined) {
                            usd = "$".concat(u.usd.toFixed(2));
                            segments.push({
                                key: 'usd',
                                text: "".concat(SEP).concat(usd),
                                drop: 3,
                                node: (<Text key="usd">
              {sep}
              <Text dimColor>{usd}</Text>
            </Text>),
                            });
                        }
                        if (Object.keys(m.byModel).length > 0) {
                            text = (0, format_1.fit)((0, format_1.modelsText)(m), 60);
                            segments.push({
                                key: 'models',
                                text: "".concat(SEP).concat(text),
                                drop: 4,
                                node: (<Text key="models">
              {sep}
              <Text dimColor>{text}</Text>
            </Text>),
                            });
                        }
                        if (a.running > 0) {
                            label = "\u2699 ".concat(a.running, " agent").concat(a.running > 1 ? 's' : '');
                            segments.push({
                                key: 'agents',
                                text: "".concat(SEP).concat(label),
                                drop: 2,
                                node: (<Text key="agents">
              {sep}
              <Text color="claude" bold>
                {label}
              </Text>
            </Text>),
                            });
                            names = (0, format_1.fit)(a.names.join(', '), 40);
                            if (names)
                                segments.push({ key: 'agent-names', text: " ".concat(names), drop: 6, requires: 'agents', node: <Text key="agent-names" dimColor> {names}</Text> });
                        }
                    }
                    contextRow = u && (<Text key="usage" wrap="truncate-end">
        {(0, format_1.fitSegments)(segments, width).map(function (s) { return s.node; })}
      </Text>);
                    waveRows = w.map(function (wave) {
                        var percent = (0, format_1.wavePercent)(wave);
                        if (!wave.live) {
                            var project_1 = (0, format_1.commonProject)(wave);
                            return (<Text key={"wave-".concat(wave.id)} color="subtle" wrap="truncate-end">
            ⟳ {project_1 ? "".concat(project_1, " \u00B7 ") : ''}
            {wave.id} {(0, format_1.waveStatusFr)(wave.status)} {(0, format_1.ago)(wave.ended, at)}
            {sep}
            budget {pct(percent)} {(0, format_1.k)(wave.consumed)}/{(0, format_1.k)(wave.budget)}
            {wave.lots.length > 0 && (<Text color="subtle">
                {sep}
                {(0, format_1.lotCounts)(wave)}
              </Text>)}
          </Text>);
                        }
                        var sessions = (0, format_1.waveSessions)(wave);
                        var project = (0, format_1.commonProject)(wave);
                        var label = function (lot) { return (project ? lot.lot : "".concat(lot.project, ":").concat(lot.lot)); };
                        var active = wave.lots.filter(function (l) { return l.status !== 'queued'; });
                        var queued = wave.lots.filter(function (l) { return l.status === 'queued'; });
                        var cells = active.map(function (lot) {
                            var c = (0, format_1.lotCells)(lot, at);
                            return { lot: lot, label: label(lot), status: c.status, detail: c.detail };
                        });
                        var lotWidth = Math.max.apply(Math, __spreadArray([0], cells.map(function (c) { return c.label.length; }), false));
                        var statusWidth = Math.max.apply(Math, __spreadArray(__spreadArray([0], cells.map(function (c) { return c.status.length; }), false), [queued.length > 0 ? 'en attente'.length : 0], false));
                        var detailWidth = Math.max.apply(Math, __spreadArray([0], cells.map(function (c) { return c.detail.length; }), false));
                        var titleWidth = width - 2 - lotWidth - 2 - statusWidth - 2 - (detailWidth > 0 ? detailWidth + 2 : 0);
                        return (<Box key={"wave-".concat(wave.id)} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="claude" bold>
              ⟳ {project ? "".concat(project, " \u00B7 ") : ''}
              {wave.id} {(0, format_1.waveStatusFr)(wave.status)}
            </Text>
            {sep}
            <Text dimColor>budget </Text>
            <Text color={(0, format_1.colorOfPercent)(percent)} bold>
              {(0, format_1.bar)(percent)} {pct(percent)}
            </Text>
            <Text dimColor>
              {' '}
              {(0, format_1.k)(wave.consumed)}/{(0, format_1.k)(wave.budget)}
            </Text>
            {sep}
            <Text dimColor>
              {sessions} session{sessions > 1 ? 's' : ''}
              {wave.cap ? "/".concat(wave.cap) : ''}
            </Text>
          </Text>
          {cells.map(function (c) { return (<Box key={"".concat(c.lot.project, ":").concat(c.lot.lot)} flexDirection="row">
              <Text>{'  '}</Text>
              <Text bold color={c.lot.status === 'question' || c.lot.status === 'failed' ? (0, format_1.colorOfLot)(c.lot.status) : 'text'}>
                {(0, format_1.pad)(c.label, lotWidth)}
              </Text>
              <Text>{'  '}</Text>
              <Text color={(0, format_1.colorOfLot)(c.lot.status)} bold={c.lot.status === 'question'}>
                {(0, format_1.pad)(c.status, statusWidth)}
              </Text>
              <Text>{'  '}</Text>
              {detailWidth > 0 && (<Text dimColor={c.lot.status !== 'question'} color={c.lot.status === 'question' ? 'warning' : undefined}>
                  {(0, format_1.pad)(c.detail, detailWidth)}
                </Text>)}
              {detailWidth > 0 && <Text>{'  '}</Text>}
              <Text color="subtle">{(0, format_1.fit)(c.lot.title, titleWidth)}</Text>
            </Box>); })}
          {queued.length > 0 && (<Box flexDirection="row">
              <Text>{'  '}</Text>
              <Text dimColor>{(0, format_1.pad)('', lotWidth)}</Text>
              <Text>{'  '}</Text>
              <Text color="subtle">{(0, format_1.pad)('en attente', statusWidth)}</Text>
              <Text>{'  '}</Text>
              <Text color="subtle" wrap="wrap">
                {queued.map(label).join(' · ')}
              </Text>
            </Box>)}
        </Box>);
                    });
                    return [2 /*return*/, (<Box flexDirection="column">
        {contextRow}
        {waveRows}
        {problem && (<Text color="warning" dimColor>
            cadence-hud : {(0, format_1.fit)(problem, width - 14)}
          </Text>)}
      </Box>)];
            }
        });
    }); });
};
exports.register = register;
