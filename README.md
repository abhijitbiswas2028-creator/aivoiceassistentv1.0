# JARVIS Voice

JARVIS is a voice-first local assistant. Its normal window contains only the energy ring and the Speak button. Requests, clarifications, confirmations, and results are spoken; internal transcripts and action records stay out of the interface.

## Run

1. Copy `.env` to `.env.local` and set `GEMINI_API_KEY`. Audio is sent to Gemini Live only while a session is active. Microphone recordings are streamed and are not saved by this app. Without this key JARVIS cannot recognize speech or reply aloud.
2. Run `npm run install-local` once. This installs project dependencies, Playwright Chromium, and a removable desktop launcher.
3. Run `scripts/jarvis-launcher.sh`, then open `http://localhost:3000`.
4. Select the microphone button to start listening. Select the same button again to mute the microphone without ending the active session; select it once more to unmute. While JARVIS is speaking, the same button becomes a stop button that ends the current response. Press `Escape`, or right-click the button, to cancel the active JARVIS operation.

## Browser connector

`npm run bridge` starts the native local bridge at `127.0.0.1:3001`. It reports its available capabilities before use. By default it opens a headed, JARVIS-managed Chromium window. To control an explicitly authorized existing Chrome session, launch Chrome with remote debugging and set `JARVIS_CHROME_CDP_URL`, for example:

```bash
google-chrome --remote-debugging-port=9222
export JARVIS_CHROME_CDP_URL=http://127.0.0.1:9222
scripts/jarvis-launcher.sh
```

The bridge uses accessibility and page structure for browser targets and provides observed page or media state with each result. Login, CAPTCHA, browser permission, and native authentication dialogs remain for the user to complete.

The bridge must run in the desktop session it is meant to control. In a headless environment it keeps scoped file and code actions available, and reports browser or desktop actions as unavailable until an authorized CDP browser connection is configured.

## Permissions and scope

The bridge only reads and writes below `JARVIS_ALLOWED_ROOT`, which defaults to the project directory. Set it to an explicit development folder to authorize another project. Browser closures, application closures, and destructive file actions require a short, expiring operation-bound voice confirmation. Development commands are limited to `npm`, `npx`, `node`, `python`, `python3`, `pytest`, `git`, and `tsc`, run with a time and output limit.

The supported desktop path is Debian/Ubuntu applications exposed by their documented launchers. JARVIS does not alter kernel, bootloader, partitions, existing desktop settings, passwords, or browser credentials.

## Verify and remove

Run `npm run diagnose` to report provider and browser-bridge state, then `npm run lint` and `npm run build` for project checks. Run `npm run uninstall-local` to remove the launcher; it leaves the repository, your files, and browser profile untouched.

Run `npm run enable-autostart` to create an optional per-user desktop autostart entry, or `npm run disable-autostart` to remove it.

## Current limits

Wake-word listening is intentionally not enabled by default. When the Gemini provider is unavailable, supported browsers can use built-in speech recognition and synthesis for a small offline command set: opening YouTube or a domain, web and YouTube search, opening VS Code, listing authorized project files, arithmetic, and spoken capabilities. A genuine demonstration recording needs a configured provider, a physical microphone, and the user’s target applications; the repository includes no fabricated recording.

Ask JARVIS “what can you do?” for a spoken summary. Current capabilities include browser navigation, accessible page inspection, tabs, YouTube playback, supported Debian desktop apps, scoped file operations, and controlled code inspection/test commands. Availability depends on the connected bridge, installed applications, and configured provider.
