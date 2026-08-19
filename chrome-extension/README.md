# Pathproof Session Recorder

This is an unpacked Chrome Manifest V3 extension. It never opens an action popup: clicking the toolbar icon opens `recorder.html` and binds that control room to the exact active tab ID and URL.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `chrome-extension` folder.
4. Pin Pathproof to the toolbar.

Click the toolbar icon while the page to test is active. Configure capture, start, complete the journey in the bound tab, stop, and download the `.pathproof.json` file. The recorder page is the live monitor because opening Chrome DevTools on the attached target would detach Chrome's debugger API.

The download has no fixed file-size or recording-duration ceiling. It preserves replay actions, navigation, selectors, pointer coordinates and hover timing, viewport/browser settings, and cookies/local storage unless you turn those capture options off. All capture options start enabled. Compositor and screenshot JPEGs remain local to the active recording and are never embedded in this JSON. Response bodies, headers, and DOM snapshots are also excluded. Noisy pointer and diagnostic streams are compacted, and `diagnostics.compactExport.omitted` reports what was left out; replay actions are not discarded to meet a byte budget.

After a recording finishes, the top **Start recording** button becomes **Record again** and starts a fresh session in the same recorder tab. The JSON download action appears beside it. Every export uses a unique timestamp-and-recording-ID filename, so a later recording never replaces the prior JSON file.

Session-state and network-body capture start enabled but can be switched off before recording. Session state can contain authentication credentials, personal information, or application secrets; it remains part of the replay file when enabled. Response bodies may be observed during capture but are excluded from the JSON export. Treat recording files like browser profiles and do not commit them.

Chrome internal pages, the Chrome Web Store, and other protected browser surfaces cannot be instrumented by extensions. Attaching the debugger also causes Chrome to show its standard debugging banner. The compositor stream contains the page surface—not browser chrome, native dialogs, audio, or the operating-system cursor—so Pathproof records debugger-backed pointer telemetry separately and renders it during replay. Compositor frames are held only for the active capture and released after the compact export is prepared.
