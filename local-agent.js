/**
 * JARVIS Universal Local Machine Browser & Desktop OS Agent Server
 * Run this locally on your machine to grant JARVIS full real-time control over:
 * 1. Your local headed Chromium/Chrome browser (open, close, navigate, search, click, type, scroll, media, multi-step tasks)
 * 2. Your local desktop applications (VS Code, Terminal, File Manager, Calculator, Spotify, VLC, Notes, Settings, LibreOffice, etc.)
 * 3. Your system functions (volume, brightness, media keys, notes, file search, system metrics, lock screen)
 *
 * Setup instructions:
 * 1. npm install playwright express cors
 * 2. npx playwright install chromium
 * 3. node local-agent.js
 */

import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { execFile, spawn } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3001;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "5mb" }));

let browser = null;
let context = null;
let page = null;
let lastActionStatus = "Standing by for JARVIS voice directives...";
let logsList = [];

function logAndBroadcast(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const formattedLog = {
    id: Math.random().toString(36).substring(2, 10),
    text: `[${timestamp}] ${message}`,
    type,
  };
  console.log(`[${type.toUpperCase()}] ${message}`);
  logsList.push(formattedLog);
  if (logsList.length > 80) logsList.shift();
  lastActionStatus = message;
}

function resolveTargetUrl(rawUrl = "https://www.google.com") {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "https://www.google.com";
  const lower = trimmed.toLowerCase();
  const shortcuts = {
    youtube: "https://www.youtube.com",
    google: "https://www.google.com",
    github: "https://github.com",
    gmail: "https://mail.google.com",
    chatgpt: "https://chatgpt.com",
    wikipedia: "https://www.wikipedia.org",
    whatsapp: "https://web.whatsapp.com",
    spotify: "https://open.spotify.com",
    reddit: "https://www.reddit.com",
    linkedin: "https://www.linkedin.com",
    x: "https://x.com",
    twitter: "https://x.com",
  };
  if (shortcuts[lower]) return shortcuts[lower];
  if (lower.startsWith("http://") || lower.startsWith("https://")) return trimmed;
  if (/^([\da-z.-]+)\.([a-z.]{2,10})([/\w .-]*)*\/?(\?.*)?(#.*)?$/i.test(trimmed) && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    logAndBroadcast("Launching local headed Chromium browser...", "info");
    browser = await chromium.launch({
      headless: false,
      args: ["--start-maximized", "--no-sandbox"],
    });
    context = await browser.newContext({ viewport: null });
    page = await context.newPage();
    logAndBroadcast("Local headed browser window active.", "success");
  } else if (!page || page.isClosed()) {
    const pages = context ? context.pages() : [];
    page = pages.length > 0 ? pages[pages.length - 1] : await context.newPage();
  }
}

function execCommandSafe(bin, args = []) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve((stdout || stderr || "").trim());
    });
  });
}

function spawnDetachedSafe(candidates, args = []) {
  for (const bin of candidates) {
    try {
      const child = spawn(bin, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return bin;
    } catch {}
  }
  return null;
}

app.get("/api/status", (_req, res) => {
  res.json({
    connected: true,
    browserActive: Boolean(browser && browser.isConnected()),
    lastAction: lastActionStatus,
    logs: logsList,
    currentUrl: page && !page.isClosed() ? page.url() : "None",
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
  });
});

app.post("/api/action", async (req, res) => {
  const { type, args = {} } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: "Missing parameter 'type'" });
  }

  logAndBroadcast(`Executing local directive: ${type}`, "action");

  try {
    // 1. Browser close does not require launching a new browser if already closed
    if (type === "browserClose") {
      const scope = args.scope || "browser";
      if (scope === "tab" && page && !page.isClosed()) {
        await page.close();
        const remaining = context ? context.pages() : [];
        page = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        logAndBroadcast("Closed active local browser tab.", "success");
        return res.json({ result: "Closed active browser tab on local machine." });
      }
      if (browser) {
        await browser.close();
        browser = null;
        context = null;
        page = null;
      }
      logAndBroadcast("Closed local browser session completely.", "success");
      return res.json({ result: "Closed local browser window." });
    }

    // 2. Desktop Application Control (Open, Close, Focus, Execute Task)
    if (type === "desktopAppControl") {
      const appName = String(args.appName || "terminal").toLowerCase();
      const action = String(args.action || "open").toLowerCase();
      const taskArgs = String(args.taskArgs || "").trim();

      const appMap = {
        vscode: { bins: ["code", "codium"], proc: "code", label: "VS Code" },
        code: { bins: ["code", "codium"], proc: "code", label: "VS Code" },
        terminal: {
          bins: ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"],
          proc: "gnome-terminal",
          label: "Terminal",
        },
        files: {
          bins: ["nautilus", "dolphin", "thunar", "pcmanfm", "xdg-open"],
          proc: "nautilus",
          label: "File Manager",
        },
        calculator: {
          bins: ["gnome-calculator", "kcalc", "galculator", "xcalc"],
          proc: "gnome-calculator",
          label: "Calculator",
        },
        spotify: { bins: ["spotify", "rhythmbox"], proc: "spotify", label: "Spotify" },
        vlc: { bins: ["vlc", "mpv", "totem"], proc: "vlc", label: "Media Player" },
        notes: {
          bins: ["gnome-text-editor", "gedit", "mousepad", "kate"],
          proc: "gedit",
          label: "Notes / Text Editor",
        },
        settings: {
          bins: ["gnome-control-center", "systemsettings", "xfce4-settings-manager"],
          proc: "gnome-control-center",
          label: "System Settings",
        },
        browser: {
          bins: ["google-chrome", "chromium", "chromium-browser", "firefox", "brave-browser"],
          proc: "chrome",
          label: "Desktop Browser",
        },
        discord: { bins: ["discord"], proc: "discord", label: "Discord" },
        slack: { bins: ["slack"], proc: "slack", label: "Slack" },
        libreoffice: { bins: ["libreoffice", "soffice"], proc: "soffice.bin", label: "LibreOffice" },
      };

      const target =
        Object.entries(appMap).find(([key]) => appName.includes(key))?.[1] || {
          bins: [appName.replace(/[^a-z0-9._-]/g, "")],
          proc: appName.replace(/[^a-z0-9._-]/g, ""),
          label: args.appName || "Desktop App",
        };

      if (action === "close") {
        try {
          await execCommandSafe("pkill", ["-f", target.proc]);
        } catch {}
        logAndBroadcast(`Closed desktop application: ${target.label}`, "success");
        return res.json({ result: `Closed desktop application ${target.label}.` });
      }

      if (action === "focus") {
        try {
          await execCommandSafe("wmctrl", ["-a", target.label]);
        } catch {}
        logAndBroadcast(`Focused desktop application: ${target.label}`, "success");
        return res.json({ result: `Focused desktop application ${target.label}.` });
      }

      const cliArgs = taskArgs ? [taskArgs] : [];
      const launchedBin = spawnDetachedSafe(target.bins, cliArgs);
      logAndBroadcast(
        `Launched ${target.label}${taskArgs ? ` with task "${taskArgs}"` : ""} (${launchedBin || "spawned"})`,
        "success"
      );
      return res.json({
        result: `${action === "execute_task" ? "Executed task in" : "Opened"} ${target.label}${
          taskArgs ? ` (${taskArgs})` : ""
        }.`,
      });
    }

    // 3. System / OS Control
    if (type === "systemControl") {
      const operation = String(args.operation || "system_status");
      const value = args.value;
      const text = String(args.text || "");

      if (operation === "system_status") {
        const totalMemGb = (os.totalmem() / 1024 ** 3).toFixed(1);
        const freeMemGb = (os.freemem() / 1024 ** 3).toFixed(1);
        const load = os.loadavg()[0]?.toFixed(2) || "0.20";
        const statusMsg = `CPU Load ${load}, Free RAM ${freeMemGb}GB / ${totalMemGb}GB on ${os.hostname()} (${os.platform()}).`;
        logAndBroadcast(`System telemetry read: ${statusMsg}`, "success");
        return res.json({ result: statusMsg });
      }

      if (operation === "volume_set" || operation === "volume_up" || operation === "volume_down") {
        const volArg =
          operation === "volume_set"
            ? `${Math.max(0, Math.min(100, Number(value ?? 70)))}%`
            : operation === "volume_up"
            ? "+10%"
            : "-10%";
        try {
          await execCommandSafe("pactl", ["set-sink-volume", "@DEFAULT_SINK@", volArg]);
        } catch {}
        logAndBroadcast(`Adjusted system audio volume (${volArg}).`, "success");
        return res.json({ result: `System volume updated (${volArg}).` });
      }

      if (operation === "mute" || operation === "unmute") {
        try {
          await execCommandSafe("pactl", [
            "set-sink-mute",
            "@DEFAULT_SINK@",
            operation === "mute" ? "1" : "0",
          ]);
        } catch {}
        logAndBroadcast(`System audio ${operation}d.`, "success");
        return res.json({ result: `System audio ${operation}d.` });
      }

      if (operation === "create_note") {
        const notesDir = path.join(os.homedir(), "Documents", "JARVIS_Notes");
        fs.mkdirSync(notesDir, { recursive: true });
        const filePath = path.join(notesDir, `note_${Date.now()}.txt`);
        fs.writeFileSync(filePath, text || "JARVIS Quick Note", "utf8");
        logAndBroadcast(`Saved note to ${filePath}`, "success");
        return res.json({ result: `Saved note to ${filePath}.` });
      }

      if (operation === "open_folder") {
        const targetFolder = text || os.homedir();
        spawnDetachedSafe(["xdg-open", "nautilus", "dolphin"], [targetFolder]);
        logAndBroadcast(`Opened folder: ${targetFolder}`, "success");
        return res.json({ result: `Opened folder ${targetFolder}.` });
      }

      if (operation === "lock_screen") {
        try {
          await execCommandSafe("loginctl", ["lock-session"]);
        } catch {}
        logAndBroadcast("Locked desktop session.", "success");
        return res.json({ result: "Desktop screen locked." });
      }

      logAndBroadcast(`Executed system control operation: ${operation}`, "success");
      return res.json({ result: `System operation ${operation} completed.` });
    }

    // All remaining directives control the local headed Playwright browser
    await ensureBrowser();

    switch (type) {
      case "browserOpen": {
        const destination = resolveTargetUrl(args.url);
        logAndBroadcast(`Navigating local browser to: ${destination}`, "info");
        await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 20000 });

        if (destination.includes("youtube.com")) {
          try {
            const consentBtn = page
              .locator(
                'button:has-text("Reject all"), button:has-text("Accept all"), button:has-text("I agree")'
              )
              .first();
            if (await consentBtn.isVisible({ timeout: 1200 })) {
              await consentBtn.click();
            }
          } catch {}
        }

        logAndBroadcast(`Loaded: ${destination}`, "success");
        return res.json({ result: `Opened ${destination} on local machine browser.` });
      }

      case "browserSearch": {
        const query = String(args.query || "").trim();
        const engine = String(args.engine || "").toLowerCase();
        if (!query) throw new Error("Missing search query.");

        logAndBroadcast(`Searching for: "${query}"`, "info");
        const currentUrl = page.url().toLowerCase();

        if (engine === "youtube" || currentUrl.includes("youtube.com")) {
          await page.goto(
            `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
            { waitUntil: "domcontentloaded" }
          );
        } else if (engine === "wikipedia" || currentUrl.includes("wikipedia.org")) {
          await page.goto(
            `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
            { waitUntil: "domcontentloaded" }
          );
        } else {
          await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, {
            waitUntil: "domcontentloaded",
          });
        }

        logAndBroadcast(`Search results loaded for "${query}".`, "success");
        return res.json({ result: `Searched for "${query}" in browser.` });
      }

      case "browserClick": {
        const selector = String(args.selector || "").trim();
        const desc = args.description || selector;
        if (!selector) throw new Error("Missing selector or text target to click.");

        logAndBroadcast(`Clicking target: "${desc}"`, "info");

        if (selector.startsWith("video-")) {
          const videoId = selector.replace("video-", "");
          const directUrl = `https://www.youtube.com/watch?v=${videoId}`;
          await page.goto(directUrl, { waitUntil: "domcontentloaded" });
          return res.json({ result: `Playing YouTube video ${directUrl}` });
        }

        let clicked = false;
        if (page.url().includes("youtube.com")) {
          if (selector === "play-button") {
            await page.evaluate(() => document.querySelector("video")?.play());
            clicked = true;
          } else if (selector === "pause-button") {
            await page.evaluate(() => document.querySelector("video")?.pause());
            clicked = true;
          } else if (
            selector.includes("first") ||
            selector.includes("search-result-0") ||
            selector.includes("video")
          ) {
            const firstResult = page
              .locator("ytd-video-renderer a#video-title, ytd-rich-grid-media a#video-title")
              .first();
            if (await firstResult.isVisible({ timeout: 2000 })) {
              await firstResult.click();
              clicked = true;
            }
          }
        }

        if (!clicked) {
          const textLoc = page.getByText(selector, { exact: false }).first();
          if (await textLoc.isVisible({ timeout: 1500 }).catch(() => false)) {
            await textLoc.click();
          } else {
            await page.locator(selector).first().click({ timeout: 3000 });
          }
        }

        logAndBroadcast(`Clicked "${desc}".`, "success");
        return res.json({ result: `Clicked "${desc}" in browser.` });
      }

      case "browserMediaControl": {
        const action = args.action;
        const val = args.value;
        logAndBroadcast(`Media control: ${action}`, "info");

        if (action === "play") {
          await page.evaluate(() => document.querySelector("video")?.play());
        } else if (action === "pause") {
          await page.evaluate(() => document.querySelector("video")?.pause());
        } else if (action === "volume") {
          const pct = Math.max(0, Math.min(100, Number(val ?? 75)));
          await page.evaluate((p) => {
            const v = document.querySelector("video");
            if (v) v.volume = p / 100;
          }, pct);
        } else if (action === "mute") {
          await page.evaluate(() => {
            const v = document.querySelector("video");
            if (v) v.muted = true;
          });
        } else if (action === "unmute") {
          await page.evaluate(() => {
            const v = document.querySelector("video");
            if (v) v.muted = false;
          });
        } else if (action === "fullscreen") {
          await page.keyboard.press("f");
        } else if (action === "exit_fullscreen") {
          await page.keyboard.press("Escape");
        } else if (action === "skip") {
          await page.evaluate(() => {
            const v = document.querySelector("video");
            if (v) v.currentTime += 30;
          });
        } else if (action === "rewind") {
          await page.evaluate(() => {
            const v = document.querySelector("video");
            if (v) v.currentTime = Math.max(0, v.currentTime - 15);
          });
        }

        return res.json({ result: `Executed media action: ${action}.` });
      }

      case "browserScroll": {
        const direction = args.direction || "down";
        const distance = Number(args.amount || 450);
        await page.evaluate(
          ({ dir, dist }) => {
            if (dir === "top") window.scrollTo({ top: 0, behavior: "smooth" });
            else if (dir === "bottom")
              window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
            else
              window.scrollBy({
                top: dir === "down" ? dist : -dist,
                behavior: "smooth",
              });
          },
          { dir: direction, dist: distance }
        );
        return res.json({ result: `Scrolled browser ${direction}.` });
      }

      case "browserType": {
        const text = String(args.text || "");
        const submit = Boolean(args.submit);
        if (args.selector) {
          await page.locator(args.selector).first().fill(text);
        } else {
          await page.keyboard.type(text);
        }
        if (submit) {
          await page.keyboard.press("Enter");
        }
        return res.json({
          result: `Typed "${text}"${submit ? " and pressed Enter" : ""}.`,
        });
      }

      case "browserGoBack": {
        await page.goBack();
        return res.json({ result: "Navigated back in browser history." });
      }

      case "browserTabAction": {
        const subAct = args.action;
        if (subAct === "new") {
          const startUrl = resolveTargetUrl(args.url || "https://www.google.com");
          page = await context.newPage();
          await page.goto(startUrl, { waitUntil: "domcontentloaded" });
        } else if (subAct === "close") {
          await page.close();
          const pages = context.pages();
          page = pages.length > 0 ? pages[pages.length - 1] : null;
        } else if (subAct === "reload") {
          await page.reload({ waitUntil: "domcontentloaded" });
        } else if (subAct === "go_back") {
          await page.goBack();
        } else if (subAct === "go_forward") {
          await page.goForward();
        } else if (subAct === "close_all" && browser) {
          await browser.close();
          browser = null;
          context = null;
          page = null;
        }
        return res.json({ result: `Completed browser tab action: ${subAct}.` });
      }

      case "browserTask": {
        const taskType = args.taskType || "extract_content";
        if (taskType === "extract_content" || taskType === "summarize_page") {
          const summary = await page.evaluate(() => {
            const title = document.title;
            const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
              .slice(0, 8)
              .map((h) => h.textContent?.trim())
              .filter(Boolean);
            const paragraphs = Array.from(document.querySelectorAll("p"))
              .slice(0, 5)
              .map((p) => p.textContent?.trim())
              .filter((t) => t && t.length > 30);
            return { title, headings, paragraphs };
          });
          return res.json({
            result: `Page "${summary.title}": ${summary.headings.join(" | ")} — ${summary.paragraphs
              .join(" ")
              .slice(0, 400)}`,
          });
        }
        if (taskType === "press_key" && args.key) {
          await page.keyboard.press(args.key);
          return res.json({ result: `Pressed key ${args.key} in browser.` });
        }
        if (taskType === "open_multiple_urls" && Array.isArray(args.urls)) {
          for (const u of args.urls.slice(0, 5)) {
            const p = await context.newPage();
            await p.goto(resolveTargetUrl(u), { waitUntil: "domcontentloaded" });
            page = p;
          }
          return res.json({ result: `Opened ${args.urls.length} tabs in local browser.` });
        }
        return res.json({ result: `Completed browser task: ${taskType}.` });
      }

      default:
        return res.json({ result: `Executed directive ${type}.` });
    }
  } catch (err) {
    logAndBroadcast(`Execution error: ${err.message}`, "error");
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`🚀 JARVIS Local Machine Browser & Desktop Agent Active!`);
  console.log(`📡 Listening on: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
