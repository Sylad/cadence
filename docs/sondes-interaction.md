# Interaction probes

A review of screens at rest does not see what happens **when the user clicks**. The case that started it (D-14, 18-11): on a map, ticking a
layer in the tree inserts a row in the « Active » list above it, and the row under the pointer jumps down by 140 px. The UX review of the
day did not see it, and Google's CLS ignores it by design (layout shifts in the 500 ms after an input are excluded). `cadence sondes`
measures it: it clicks, follows the clicked element frame by frame, and reports every pixel it moved.

The probes are generic: nothing in them belongs to one project. The `ux-reviewer` and `qa-reviewer` agents run them on every page they
review ([skills](skills.md)), and a project adds its own journeys in its QA expectations file ([news](news.md#qa-review)).

## Command

```bash
cadence sondes <url> [--largeur 1440] [--hauteur 900] [--seuil 1] [--max 30] [--par-liste 3] [--attente 1000] [--charge 5000] \
  [--repos 3000] [--attendus docs/qa/expectations.md] [--route /path] [--sans-balayage] [--json file] [--captures folder]
```

| Code | Meaning |
|---|---|
| 0 | every click measured, no finding |
| 1 | findings, and only then |
| 3 | no finding, but a partial pass: clicks not measured (`?`), or a page error on a removed function, see below |
| 4 | not measurable: no click measured at all (every control covered, none on the page, all refused) |
| 2 | not verified: usage error, unreadable expectations, no browser, the read-only guard not armed, a target not guarded (see Read only), or a pass broken by an error |

A click is « not measured » when the control vanished or was refused, was covered by another element at this viewport size, was replaced
by the click with no single equivalent to follow, when a journey found fewer elements than it asks for, or when the click tried to write
(blocked, so the app did not get its answer: its real effect is not verified). The text report gives the findings first (`✗`), then the
clicks not measured (`?`), then the writes blocked (`!`, with the control that sent them), then one line of measures per control;
`--json` writes every measure, `--captures` one screenshot per finding. A partial pass never reads as « no finding », and a pass with no
click measured reads « aucun clic mesuré : non mesurable »: what was not measured is not verified.

Playwright is not a dependency of the package. The command takes it from the machine, in the order the `qa-reviewer` uses:
`CADENCE_PLAYWRIGHT`, the `node_modules` of the current folder, the package of a running Playwright MCP server, the newest npx cache; it
launches the bundled Chromium of each package (each path once), else the installed Chrome (`channel: 'chrome'`), tried once: it is the
same for every package. It never installs anything: without a browser it says so
(code 2) and the pass is « not verified ». A browser that renders no animation frame (a stuck GPU, seen on 18-11 under WSL: no click can
complete) is relaunched with software rendering (`--use-gl=disabled`); the report header says so, and WebGL is then off: what a WebGL
map draws is not probed. Its temporary folders (profile, artefacts) live in a folder of its own, removed at the end.

**Read only.** The probe closes the ways a page can write that it knows of, and counts every attempt with the control that made it. Two
mechanisms, each stated for what was measured against a local HTTP and WebSocket server that records all it receives.

*Cut in the browser* (`scripts/sondes-garde.mjs`, over the DevTools protocol, through the debugging port Chromium opens on 127.0.0.1 for
the pass, and Playwright's WebSocket routing):

- HTTP other than `GET`, `HEAD`, `OPTIONS` (fetch, XHR, `keepalive`, `<a ping>`, a CSP report, a `POST` form) is refused **in the
  browser's network**, before it leaves, for the page, its iframes, popups and dedicated `Worker`s (classic, module, blob, nested); a
  form navigation gets an empty 204, so the page stays; `navigator.sendBeacon` returns false;
- WebSocket messages of the page and of its iframes: the connection opens and the page receives, the messages it sends are not
  forwarded (Playwright's WebSocket routing);
- a dedicated `Worker` is attached paused at its start (nested ones too): the `send` of its WebSockets forwards nothing, even for a script
  that keeps the native function in a variable, and `WebSocketStream` and `WebTransport` throw there;
- `RTCPeerConnection` throws in the page. `EventSource` only reads (a `GET`), so it passes.

*Removed from the page* (third review, r3). Closing each writing API one by one did not converge: a `SharedWorker` started before the
guard reached it and still wrote through its WebSocket, and `WebSocketStream` passed in the page. So what the guard cannot close for sure
is taken away: an init script that runs **before any script of the page**, in the page, every iframe and every popup, makes `SharedWorker`,
`WebSocketStream` and `WebTransport` `undefined` (as in a browser that does not have them; the page can neither delete nor redefine the
property) and makes `navigator.serviceWorker.register` return a rejected promise. A page that tests for them takes its fallback. A page
that calls one without testing throws (`SharedWorker is not a constructor`) and its script stops there: the probe keeps that error
(`? erreur de la page sur une fonction coupée : …`) and the pass is partial (code 3), never « no finding ». Each time the page asks for
one, the report says so:

```text
  fonction coupée pendant la sonde : SharedWorker (demandée 2 fois par la page ou un iframe ; un test de présence compte) — ce qui en dépend dans l'app n'est pas sondé
```

A feature test (`typeof WebTransport`) counts as asking: the probe cannot tell it from a use. What the app does with the removed function
(a socket kept in a `SharedWorker`, an offline cache) is not probed, and a reviewer reads that line before trusting « no finding ».

The report says what the read-only covered for the pass (`lecture seule : …`, the number of dedicated workers it guarded, the functions
removed, and what is not covered) and counts the writes « cut in the browser before they left it »; it never says the server received
nothing, which it cannot measure. The pass is « not verified » (code 2, `✗ cible non gardée`) when a worker could not be attached, when a
`SharedWorker` or a service worker starts although the page cannot create one, or when a function could not be removed; without the
debugging port the probe refuses to run (code 2).

**Not covered:** a `GET` that writes; a real `WebTransport` session (no HTTP/3 server in the tests: only the absence of the constructor in
the page and its throwing in a dedicated worker are verified); a browser other than Chromium (the guard speaks its protocol); while the
pass runs, the debugging port is open to local processes of the machine.

A `GET` that writes on the server side (`?delete=1`) passes: nothing in the request says so. The context is anonymous (no session), which
most apps refuse to write for anyway. The sweep never presses a link, a submit or reset button, a button of a `POST` form, or a control
whose name says it deletes, sends, saves, publishes, pays, signs in or out, downloads, exports or prints; an icon button with no name is
pressed, and what it tries to write is blocked and reported. The `cliquer` steps of a journey press what their selector names, without
this filter: the project declares them. A checkbox, switch or pressed button it flips is flipped back (the second click is measured too);
a radio button cannot be unticked by a click and stays where the probe put it, in a context thrown away at the end.

A control that navigates (`location.href = …` in a button) is reported « navigates to <url> (page reopened) »: its jump has no meaning,
it is neither a finding nor a click not measured, and the page is reopened in a fresh tab before the next control.

## What is measured

The page is opened, left to settle (`--charge`, 5 s), then:

1. **Scroll at rest**: the scroll positions of the window and of every scrollable element, taken twice `--repos` ms apart (3 s) with no
   gesture. Any change is a finding: the page scrolls by itself.
2. **The sweep**: every visible checkbox, radio, switch or pressed button, every button of a list (a `li`, `treeitem`, `row`, `option`, or
   an element repeated among its siblings, which catches lists built from `div`s and `label`s), every button with `aria-haspopup`. A control
   covered by another element at its centre (a folded panel, the map of a phone layout) is not pressed (the user cannot click it either) and
is reported as not measurable at this viewport size. At most
   `--par-liste` per list (3) and `--max` in all (30), in document order. For each one:
   - **jump**: the top of the clicked element, before the click and then at every animation frame for `--attente` ms (1 s); the largest
     shift and the final one are kept. When the click replaces the element by a new node (a list rebuilt without a stable key), the
     probe follows its single equivalent (same tag, type, id, name, role and accessible name); with none or several, the click is not
     measured, never a jump of 0;
   - **changed region**: a `MutationObserver` records what the click added or changed in the DOM, outside the element and its ancestors;
     the report gives the nearest changed region (side and distance in px, edge to edge) and the nearest one **above** the element, which
     is what pushes it down;
   - **effect out of view**: regions changed, none of them visible in the viewport;
   - **scroll undergone**: a scroll position that moved although the user did not scroll;
   - **dialog**: when the click opened a dialog (`dialog[open]`, `role=dialog|alertdialog`, `aria-modal`), whether the focus is inside it,
     then Escape is pressed: whether it closes, and whether the focus goes back to the control that opened it.
3. **The journeys** of the project (below), each from a freshly loaded page, measured the same way.

## Thresholds

| Measure | Expected | Finding when | Rule |
|---|---|---|---|
| jump of the clicked element | 0 px | more than `--seuil` (1 px, room for sub-pixel rounding) | the target stays under the pointer: a moved target turns the next click into a wrong click (Nielsen 3 and 5); CLS does not count it |
| scroll undergone, at rest or after a click | none | any movement of 1 px or more | the user keeps control of the view (Nielsen 3) |
| changed region | near the control | all changed regions out of view | visibility of system status (Nielsen 1) |
| focus at the opening of a dialog | inside | outside | WCAG 2.4.3, ARIA APG Dialog pattern |
| Escape on an open dialog | closes it | stays open | ARIA APG Dialog pattern, WCAG 2.1.2 |
| focus after Escape | back on the opener | elsewhere | WCAG 2.4.3 |

The probe measures, the reviewer judges: a control that travels on purpose with what it opens (the handle of a bottom sheet, measured at
−391 px on a phone layout) is reported like any jump, and the review says it is deliberate rather than counting it as a defect.

The distance to the changed region is a measure, not a finding: a reviewer reads it to explain a jump (« region changed above, 12 px »)
or to judge feedback that appears far from the control.

## Journeys of a project

A project declares its own journeys in its QA expectations file (`docs/qa/expectations.md`, or the `qa.expectations` key), in the section
of the route, one line each:

```markdown
## /map
- shows: the map and the layer panel
- parcours: tick 3 neighbouring layers → cliquer `label.layer-toggle input` ×3
- parcours: open then close the legend → cliquer button.layer-legend-fab ; attendre 500 ; touche Escape
```

`parcours: <name> → <step> ; <step> …`. Steps: `cliquer <CSS selector> [×N]` clicks the first N visible matches, neighbours in document
order, one after the other, each one measured like a control of the sweep (jump, region, scroll, dialog); `touche <key>` presses a key
(after a dialog opened, Escape is checked as above); `attendre <ms>` waits. An unreadable step stops the command (code 2) and quotes the
line. The section is the one whose title equals the path of the URL, or `--route`. A journey is not undone: the next one starts from a
fresh page. `--sans-balayage` runs the journeys alone.

## Tests

`test/sondes-interaction-l778.test.ts` plays the probes in a real browser on local pages (`test/fixtures/sondes/`): a list whose rows jump
when ticked (the D-6 case reduced to the bone) and the same list that does not jump, a good and a bad dialog, a box that scrolls by itself,
icon buttons that write through the page and through dedicated workers (classic, module, blob, one keeping the native `send`): a local
HTTP and WebSocket server, `test/sondes-serveur-l778.ts`, records what it receives, and receives no write;
the two trials of the third review (`test/sondes-essais-r3-l778.ts`: a `SharedWorker` that keeps `send`, `WebSocketStream` in the page,
four kinds of iframe, a popup, a burst of workers writing at their first line, a service worker, `<a ping>`, forms, a CSP report): no
write received, the `SharedWorker` never loaded;
buttons that navigate by script, a page where every control is covered, a list rebuilt by the click.
The browser part is skipped, and says so, on a machine with no loadable Playwright.
