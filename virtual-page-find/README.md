# Virtual Page Find (0.1.1)

Experimental Firefox and Chrome Manifest V3 extension for finding literal text in scrollable/virtualized web pages. Built from scratch; no runtime or build dependencies. The browser toolbar popup controls a scan in the top frame. It never injects a panel into the website.

## Build and load

From this directory, run `python3 build.py` (Python 3.9+). Output: `dist/firefox/`, `dist/chrome/` and deterministic ZIP archives.

- Firefox 140+: open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/firefox/manifest.json`. Temporary installs disappear on browser restart. Permanent normal installation requires Mozilla signing.
- Chrome: open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select `dist/chrome/`.

Open a normal website, click the toolbar icon, select its scroll container (largest visible scrollable area is suggested), enter a literal query, choose a scan speed and click Scan. Normal waits at least 550 ms per view; Fast 250 ms is suitable for static/quickly updated pages, Slow 1000 ms for debounced rendering. Very slow or continuously changing pages can still exceed the wait or overall scan limit. Results appear in page order with context and approximate vertical offset. Click a result to navigate; verification can fail if the layout changed. Copy matches copies plain text. Clear discards the current results. Stop cancels scanning; the original numerical scroll position is restored unless the user interrupted by interacting with the page. Closing the popup does not stop a scan; reopen to see progress. Results live only in the injected isolated-world memory until cleared or navigation/reload.

## Safety and scope

Only `activeTab` and `scripting`: no host permissions, background scripts, persistent storage, telemetry, network requests, remote code, dependencies, cookie/history access or website DOM modifications. The extension does scroll the page, which can naturally trigger the site's own network activity or lazy loading. It does not inspect API responses or private application state.

Scanning starts at the top, overlaps viewports, waits for mutations and scroll geometry to settle, and checks the bottom twice. The scanner reports limits, unstable layout, stalled scrolling and cancellation; **even a traversal that reaches both ends is best effort**, not proof that all data was loaded. Repeated hits are deduplicated heuristically by match/context and coordinates; persistent sticky/fixed labels use text-node identity and offset instead. Recycled/recreated pinned nodes remain best effort. Negative scroll offsets in horizontal-writing-mode column-reverse flex containers are normalized. Text wholly clipped by ordinary overflow ancestors is excluded; this is not pixel-perfect occlusion detection. Text is searched across adjacent inline text nodes within a block; no general rendered-text normalization. Only the selected vertical scroll container is scanned, not all nested scroll areas, shadow roots, cross-origin frames, canvas, pseudo-elements or virtualized columns. Literal searches only in v0.1; arbitrary regex intentionally omitted to avoid blocking the page with pathological regex. Page interactions stop the scan. Safety caps: 180 seconds, 1200 views, 1000 results, 80000 text nodes or 2 million characters per view. Restoration/jump can be inaccurate when scroll geometry changes. No actual ChatGPT account data was used to develop this version.

## Test

`node tests/core.test.cjs` exercises the actual search, overlapping steps and deduplication helpers (Node 18+).
For a browser smoke test, run `python3 -m http.server 8000` here and visit `http://localhost:8000/tests/virtual-list.html`. Load extension, select main list, search Yesterday. Expect 7 hits, including identical consecutive labels and split inline text; initial scroll position should be restored. Case-sensitive mode should yield 6. Test cancellation, copy, navigation and popup reopen. Repeat in Firefox and Chrome, then on a long ChatGPT task conversation. The actual extension popup and ChatGPT still require manual validation.

Automated DOM-engine integration test (not the extension popup/API integration): `npm install --no-save --package-lock=false playwright@1.56.1`, `npx playwright install chromium firefox`, then `node tests/browser-smoke.mjs all`. Playwright is optional, development-only, and never included in the packaged extension. The test checks container discovery, exact match counts and order, split text, identical labels, navigation, restoration and cancellation.

Regression fixtures cover 350 ms debounced rendering, repeated sticky labels, negative scroll offsets and nested overflow clipping in both browsers.
