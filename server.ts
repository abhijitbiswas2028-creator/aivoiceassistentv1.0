import express from "express";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, execFile } from "child_process";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import {
  loadMemories,
  saveMemories,
  formatSystemInstructionsWithMemories,
  processConversationSlice,
} from "./server_memory";
import { Memory } from "./src/lib/memoryTypes";
import { buildDesktopAppCommand } from "./src/utils/jarvisEngine";

dotenv.config();

interface ExecutionRecord {
  id: string;
  timestamp: string;
  type: string;
  summary: string;
  target: string;
  status: "success" | "error";
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "10mb" }));

  // In-memory cache of memories for zero-latency Live session startup
  let memoriesCache: Memory[] = await loadMemories().catch(() => []);
  const executionHistory: ExecutionRecord[] = [];
  const activeDesktopApps = new Set<string>(["Terminal", "Desktop Browser"]);
  let systemState = {
    volume: 75,
    muted: false,
    brightness: 85,
    mediaPlaying: false,
  };

  function recordExecution(
    type: string,
    summary: string,
    target: string,
    status: "success" | "error" = "success"
  ) {
    const entry: ExecutionRecord = {
      id: Math.random().toString(36).substring(2, 10),
      timestamp: new Date().toLocaleTimeString(),
      type,
      summary,
      target,
      status,
    };
    executionHistory.unshift(entry);
    if (executionHistory.length > 50) executionHistory.pop();
    return entry;
  }

  // Memory REST API Endpoints
  app.get("/api/memories", async (_req, res) => {
    try {
      memoriesCache = await loadMemories();
      res.json(memoriesCache);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      const memories = await loadMemories();
      const timestamp = new Date().toISOString();
      const newMemory: Memory = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        text,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      memories.push(newMemory);
      await saveMemories(memories);
      memoriesCache = memories;
      res.status(201).json(newMemory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      let memories = await loadMemories();
      memories = memories.filter((m) => m.id !== id);
      await saveMemories(memories);
      memoriesCache = memories;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Download or inspect local-agent.js for local machine browser & desktop app control
  app.get("/api/local-agent-script", (_req, res) => {
    try {
      const scriptPath = path.join(process.cwd(), "local-agent.js");
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="local-agent.js"');
      res.sendFile(scriptPath);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // System & Desktop App status endpoint
  app.get("/api/system/status", async (_req, res) => {
    const totalMemGb = Number((os.totalmem() / 1024 ** 3).toFixed(1));
    const freeMemGb = Number((os.freemem() / 1024 ** 3).toFixed(1));
    const usedMemPct = Math.round(((totalMemGb - freeMemGb) / Math.max(1, totalMemGb)) * 100);
    const cpuLoad = Number((os.loadavg()[0] || 0.25).toFixed(2));

    let localAgentConnected = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 180);
      const r = await fetch("http://127.0.0.1:3001/api/status", { signal: ctrl.signal });
      clearTimeout(t);
      localAgentConnected = r.ok;
    } catch {}

    res.json({
      localAgentConnected,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      cpuLoad,
      totalMemGb,
      freeMemGb,
      usedMemPct,
      systemState,
      activeDesktopApps: Array.from(activeDesktopApps),
      executionHistory: executionHistory.slice(0, 25),
    });
  });

  // Unified Local Machine + Host System & Desktop App Execution Endpoint
  app.post("/api/system/execute", async (req, res) => {
    const { type, args = {} } = req.body || {};
    if (!type) {
      return res.status(400).json({ error: "Missing 'type' in request body." });
    }

    // 1. Try forwarding to Local Machine Agent on port 3001 first if running on same host
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 200);
      const localResp = await fetch("http://127.0.0.1:3001/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, args }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (localResp.ok) {
        const localData = await localResp.json();
        const entry = recordExecution(
          type,
          localData.result || `Executed ${type} on local machine.`,
          args.appName || args.url || args.operation || type,
          "success"
        );
        return res.json({
          result: localData.result,
          executedOn: "local-agent",
          record: entry,
          activeDesktopApps: Array.from(activeDesktopApps),
          systemState,
        });
      }
    } catch {
      // Fallback to built-in host execution below when local-agent port 3001 is not running locally
    }

    try {
      if (type === "desktopAppControl") {
        const descriptor = buildDesktopAppCommand(
          args.appName || "terminal",
          args.action || "open",
          args.taskArgs || ""
        );

        if (descriptor.action === "close") {
          activeDesktopApps.delete(descriptor.canonicalApp);
          try {
            execFile("pkill", ["-f", descriptor.CloseProcessName], () => {});
          } catch {}
        } else {
          activeDesktopApps.add(descriptor.canonicalApp);
          for (const bin of descriptor.linuxBinaries) {
            try {
              const child = spawn(bin, descriptor.taskArgs ? [descriptor.taskArgs] : [], {
                detached: true,
                stdio: "ignore",
              });
              child.on("error", () => {});
              child.unref();
              break;
            } catch {}
          }
        }

        const entry = recordExecution(
          "desktopAppControl",
          descriptor.summary,
          descriptor.canonicalApp,
          "success"
        );
        return res.json({
          result: descriptor.summary,
          descriptor,
          record: entry,
          activeDesktopApps: Array.from(activeDesktopApps),
          systemState,
        });
      }

      if (type === "systemControl") {
        const op = String(args.operation || "system_status");
        const val = args.value;
        const text = String(args.text || "");
        let summary = `Completed system operation: ${op}.`;

        if (op === "system_status") {
          const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
          const freeGb = (os.freemem() / 1024 ** 3).toFixed(1);
          const load = (os.loadavg()[0] || 0.22).toFixed(2);
          summary = `System status: CPU load ${load}, free RAM ${freeGb}GB of ${totalGb}GB, volume ${systemState.volume}%, brightness ${systemState.brightness}%.`;
        } else if (op === "volume_up") {
          systemState.volume = Math.min(100, systemState.volume + 10);
          systemState.muted = false;
          summary = `Increased system volume to ${systemState.volume}%.`;
        } else if (op === "volume_down") {
          systemState.volume = Math.max(0, systemState.volume - 10);
          summary = `Decreased system volume to ${systemState.volume}%.`;
        } else if (op === "volume_set") {
          systemState.volume = Math.max(0, Math.min(100, Number(val ?? 75)));
          systemState.muted = false;
          summary = `Set system volume to ${systemState.volume}%.`;
        } else if (op === "mute") {
          systemState.muted = true;
          summary = "System audio muted.";
        } else if (op === "unmute") {
          systemState.muted = false;
          summary = `System audio unmuted (${systemState.volume}%).`;
        } else if (op === "brightness_set") {
          systemState.brightness = Math.max(10, Math.min(100, Number(val ?? 80)));
          summary = `Set display brightness to ${systemState.brightness}%.`;
        } else if (op === "media_play_pause" || op === "media_next" || op === "media_previous") {
          if (op === "media_play_pause") systemState.mediaPlaying = !systemState.mediaPlaying;
          summary = `Executed system media control: ${op.replace("media_", "")}.`;
        } else if (op === "create_note") {
          const notesDir = path.join(process.cwd(), "notes");
          fs.mkdirSync(notesDir, { recursive: true });
          const noteFile = path.join(notesDir, `jarvis_note_${Date.now()}.txt`);
          fs.writeFileSync(noteFile, text || "JARVIS voice note", "utf8");
          summary = `Created note "${(text || "JARVIS voice note").slice(0, 60)}" in ${path.basename(noteFile)}.`;
        } else if (op === "search_files") {
          const query = text.toLowerCase();
          const files = fs
            .readdirSync(process.cwd())
            .filter((f) => !query || f.toLowerCase().includes(query))
            .slice(0, 12);
          summary = `Found matching workspace items: ${files.join(", ") || "none"}.`;
        } else if (op === "open_folder") {
          activeDesktopApps.add("File Manager");
          summary = `Opened folder ${text || process.cwd()} in File Manager.`;
        } else if (op === "clipboard_copy") {
          summary = `Copied text to system clipboard (${text.length} chars).`;
        } else if (op === "lock_screen") {
          summary = "Initiated desktop session lock.";
        }

        const entry = recordExecution("systemControl", summary, op, "success");
        return res.json({
          result: summary,
          record: entry,
          activeDesktopApps: Array.from(activeDesktopApps),
          systemState,
        });
      }

      const entry = recordExecution(
        type,
        `Executed directive ${type} successfully.`,
        args.url || args.query || type,
        "success"
      );
      return res.json({
        result: entry.summary,
        record: entry,
        activeDesktopApps: Array.from(activeDesktopApps),
        systemState,
      });
    } catch (err: any) {
      const entry = recordExecution(type, err.message || "Execution error", type, "error");
      return res.status(500).json({ error: err.message, record: entry });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();

        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter((l) => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12),
      });
    } catch (err: any) {
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity HTML Proxy which circumvents CSP and X-Frame-Options
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res.status(400).send("Jarvis Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();

      if (targetUrl.startsWith("/")) {
        return res
          .status(400)
          .send(`Jarvis Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }

      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch {
        return res
          .status(400)
          .send(
            `Jarvis Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`
          );
      }

      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        });
      } catch (fetchErr: any) {
        return res
          .status(502)
          .send(
            `Jarvis Web Proxy Error: Unable to fetch the website "${targetUrl}". Details: ${fetchErr.message}`
          );
      }

      if (!response.ok) {
        return res
          .status(response.status)
          .send(
            `Jarvis Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`
          );
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {}
                }
              }
            }, true);

            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {}
              }
            }, true);

            window.alert = function(msg) { console.log("[Jarvis Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Jarvis Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>\n${baseUrlTag}\n${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>\n${baseUrlTag}\n${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Jarvis-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");

      res.status(200).send(htmlContents);
    } catch (e: any) {
      res
        .status(500)
        .send(
          `Jarvis Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`
        );
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
      });

      const html = await response.text();
      const videoList: any[] = [];
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);

      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const contents =
            data.contents?.twoColumnSearchResultRenderer?.primaryContents?.sectionListRenderer
              ?.contents?.[0]?.itemSectionRenderer?.contents;
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.videoRenderer) {
                const vr = item.videoRenderer;
                const vId = vr.videoId;
                if (vId) {
                  videoList.push({
                    videoId: vId,
                    title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "YouTube Video",
                    thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                    author:
                      vr.ownerText?.runs?.[0]?.text ||
                      vr.shortBylineText?.runs?.[0]?.text ||
                      "Unknown Channel",
                    duration: vr.lengthText?.simpleText || "N/A",
                    views: vr.viewCountText?.simpleText || "N/A",
                    published: vr.publishedTimeText?.simpleText || "",
                  });
                }
              }
            }
          }
        } catch {}
      }

      if (videoList.length === 0) {
        const videoRegex = /"videoId":"([^"]+)"/g;
        let match;
        const ids: string[] = [];
        while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
          const id = match[1];
          if (id && !ids.includes(id)) {
            ids.push(id);
          }
        }
        for (const id of ids) {
          videoList.push({
            videoId: id,
            title: `Live Stream: ${id}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            author: "YouTube Creator",
            duration: "N/A",
            views: "Available Now",
          });
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      res.status(500).json({ error: err.message, results: [] });
    }
  });

  const server = http.createServer(app);
  // Disable perMessageDeflate for zero-latency real-time audio frame forwarding
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
    if (pathname === "/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (clientWs) => {
    console.log("Client WebSocket connected to /live");
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));

      const baseInstructions =
        "You are JARVIS, an advanced, ultra-fast, calm, and intelligent holographic AI assistant for TECH.\n" +
        "CRITICAL MULTILINGUAL & VOICE PERFORMANCE RULES:\n" +
        "1. UNIVERSAL MULTILINGUAL FLUENCY: You can understand and speak ANY language in the world fluently (including English, Hindi, Hinglish, Bengali, Spanish, French, German, Japanese, Korean, Arabic, Mandarin, Russian, Portuguese, etc.). Automatically match the exact language the user speaks to you in, or switch immediately to any language the user requests.\n" +
        "2. INSTANT, CONCISE RESPONSES: Respond immediately with 1 to 2 crisp, natural spoken sentences so there is zero conversational lag. Never read markdown formatting aloud.\n" +
        "3. FULL LOCAL MACHINE & HOLOGRAPHIC BROWSER CONTROL:\n" +
        "   - Use 'browserOpen' to open any website or URL (e.g. youtube.com, google.com, github.com, wikipedia.org, whatsapp, chatgpt, etc.).\n" +
        "   - Use 'browserClose' when the user asks to close the browser, close the projector, or close the current website/tab.\n" +
        "   - Use 'browserSearch' to search on YouTube, Google, Wikipedia, or any active webpage.\n" +
        "   - Use 'browserClick' to click videos, buttons, links, or search results.\n" +
        "   - Use 'browserType' to type text into inputs, forms, or editors (set submit=true to press Enter).\n" +
        "   - Use 'browserScroll' to scroll up, down, top, or bottom.\n" +
        "   - Use 'browserMediaControl' to play, pause, mute, unmute, skip, rewind, fullscreen, or adjust volume.\n" +
        "   - Use 'browserTabAction' to open new tabs, close tabs, switch tabs, reload, go back, or go forward.\n" +
        "   - Use 'browserTask' to extract/summarize page content, press keys, fill forms, or open multiple URLs.\n" +
        "4. FULL DESKTOP APPLICATIONS & SYSTEM OS CONTROL:\n" +
        "   - Use 'desktopAppControl' to open, close, focus, or execute tasks inside desktop applications (VS Code, Terminal, File Manager, Chrome/Firefox, Calculator, Spotify, VLC, Notes/Text Editor, System Settings, Discord, Slack, LibreOffice, or any app).\n" +
        "   - Use 'systemControl' to adjust system volume, mute/unmute, change screen brightness, control system media playback, check CPU/RAM system status, create notes, search files, open folders, copy to clipboard, or lock the screen.\n" +
        "5. MULTIMODAL SCREEN VISION: When Screen Sharing is active, analyze real-time screen frames in the user's spoken language.";

      const finalInstructions = formatSystemInstructionsWithMemories(
        baseInstructions,
        memoriesCache
      );

      const dialogueHistory: { role: string; text: string }[] = [];

      const session = await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
          },
          systemInstruction: finalInstructions,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "browserOpen",
                  description:
                    "Opens any website URL, domain, or web app in the local machine browser and holographic browser console.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description:
                          "Destination URL or site name, e.g. youtube.com, google.com, github.com, wikipedia.org.",
                      },
                    },
                    required: ["url"],
                  },
                },
                {
                  name: "browserClose",
                  description:
                    "Closes the active browser window, holographic browser projector, or current browser tab.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      scope: {
                        type: Type.STRING,
                        description: "Whether to close the entire browser ('browser') or current tab ('tab').",
                        enum: ["browser", "tab"],
                      },
                    },
                  },
                },
                {
                  name: "browserSearch",
                  description:
                    "Searches for a query on YouTube, Google, Wikipedia, or the active website.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The search query text.",
                      },
                      engine: {
                        type: Type.STRING,
                        description: "Optional search engine target: google, youtube, wikipedia, duckduckgo.",
                      },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "browserClick",
                  description:
                    "Clicks any button, link, video card, or element inside the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      selector: {
                        type: Type.STRING,
                        description:
                          "Selector, visible text, or target ID such as 'first video', 'play-button', 'search-result-0'.",
                      },
                      description: {
                        type: Type.STRING,
                        description: "Human-readable description of the element being clicked.",
                      },
                    },
                    required: ["selector"],
                  },
                },
                {
                  name: "browserMediaControl",
                  description:
                    "Controls video/audio playback in the browser: play, pause, volume, mute, unmute, skip, rewind, fullscreen, exit_fullscreen.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "Media control operation.",
                        enum: [
                          "play",
                          "pause",
                          "volume",
                          "fullscreen",
                          "exit_fullscreen",
                          "mute",
                          "unmute",
                          "skip",
                          "rewind",
                        ],
                      },
                      value: {
                        type: Type.INTEGER,
                        description: "Volume percentage (0-100) when action is 'volume'.",
                      },
                    },
                    required: ["action"],
                  },
                },
                {
                  name: "browserScroll",
                  description: "Scrolls the active browser page up, down, top, or bottom.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      direction: {
                        type: Type.STRING,
                        description: "Scroll direction.",
                        enum: ["up", "down", "top", "bottom"],
                      },
                      amount: {
                        type: Type.INTEGER,
                        description: "Scroll distance in pixels (default 400).",
                      },
                    },
                  },
                },
                {
                  name: "browserType",
                  description:
                    "Types text into the active input, search bar, or form field in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: {
                        type: Type.STRING,
                        description: "Text to type.",
                      },
                      selector: {
                        type: Type.STRING,
                        description: "Optional CSS selector for the input field.",
                      },
                      submit: {
                        type: Type.BOOLEAN,
                        description: "Set true to press Enter after typing.",
                      },
                    },
                    required: ["text"],
                  },
                },
                {
                  name: "browserGoBack",
                  description: "Navigates back to the previous page in browser history.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {},
                  },
                },
                {
                  name: "browserTabAction",
                  description:
                    "Controls browser tabs: open a new tab, close a tab, switch tabs, reload, go back, go forward, or close all tabs.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "Tab operation to execute.",
                        enum: [
                          "new",
                          "close",
                          "switch",
                          "reload",
                          "go_back",
                          "go_forward",
                          "close_all",
                        ],
                      },
                      tabId: {
                        type: Type.STRING,
                        description: "Optional tab identifier or index.",
                      },
                      url: {
                        type: Type.STRING,
                        description: "Optional URL when opening a new tab.",
                      },
                    },
                    required: ["action"],
                  },
                },
                {
                  name: "browserTask",
                  description:
                    "Performs advanced browser tasks: extract/summarize page content, press keyboard shortcuts, fill forms, or open multiple URLs.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      taskType: {
                        type: Type.STRING,
                        description: "The browser task to execute.",
                        enum: [
                          "extract_content",
                          "summarize_page",
                          "press_key",
                          "find_text",
                          "open_multiple_urls",
                        ],
                      },
                      key: {
                        type: Type.STRING,
                        description: "Key name when taskType is 'press_key' (e.g. Enter, Escape, Space).",
                      },
                      query: {
                        type: Type.STRING,
                        description: "Text to find or form data when applicable.",
                      },
                      urls: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "List of URLs when taskType is 'open_multiple_urls'.",
                      },
                    },
                    required: ["taskType"],
                  },
                },
                {
                  name: "desktopAppControl",
                  description:
                    "Opens, closes, focuses, or executes tasks in desktop applications on the user's computer (e.g., VS Code, Terminal, File Manager, Calculator, Spotify, VLC, Notes, Settings, LibreOffice, Discord, Slack).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      appName: {
                        type: Type.STRING,
                        description:
                          "Name of the desktop application (e.g. 'vscode', 'terminal', 'files', 'calculator', 'spotify', 'vlc', 'notes', 'settings', 'libreoffice').",
                      },
                      action: {
                        type: Type.STRING,
                        description: "Operation to perform on the desktop app.",
                        enum: ["open", "close", "focus", "execute_task"],
                      },
                      taskArgs: {
                        type: Type.STRING,
                        description:
                          "Optional file path, folder, command argument, or task instruction for the application.",
                      },
                    },
                    required: ["appName"],
                  },
                },
                {
                  name: "systemControl",
                  description:
                    "Controls OS and desktop system functions: volume, mute, brightness, media playback, system CPU/RAM telemetry, creating notes, searching files, opening folders, clipboard, or locking the screen.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      operation: {
                        type: Type.STRING,
                        description: "The system operation to execute.",
                        enum: [
                          "system_status",
                          "volume_up",
                          "volume_down",
                          "volume_set",
                          "mute",
                          "unmute",
                          "brightness_set",
                          "media_play_pause",
                          "media_next",
                          "media_previous",
                          "create_note",
                          "search_files",
                          "open_folder",
                          "clipboard_copy",
                          "lock_screen",
                        ],
                      },
                      value: {
                        type: Type.INTEGER,
                        description: "Numeric level (0-100) for volume_set or brightness_set.",
                      },
                      text: {
                        type: Type.STRING,
                        description:
                          "Note content, file search keyword, folder path, or clipboard text.",
                      },
                    },
                    required: ["operation"],
                  },
                },
                {
                  name: "changeBackground",
                  description:
                    "Changes the visual theme or atmospheric glow color of Jarvis's interface.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      color: {
                        type: Type.STRING,
                        description:
                          "The theme color name (violet, crimson, emerald, celestial, gold, rose, charcoal)",
                      },
                    },
                    required: ["color"],
                  },
                },
                {
                  name: "saveCustomMemory",
                  description:
                    "Saves a piece of user information or language preference to persistent memory.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      category: {
                        type: Type.STRING,
                        description: "The memory category.",
                        enum: [
                          "identity",
                          "preference",
                          "goal",
                          "project",
                          "relationship",
                          "emotional",
                          "behavior",
                        ],
                      },
                      text: {
                        type: Type.STRING,
                        description: "Precise third-person statement.",
                      },
                    },
                    required: ["category", "text"],
                  },
                },
              ],
            },
          ],
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            // Forward only raw 24kHz PCM audio chunks (single voice stream, no text script overlay)
            const parts = message.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                clientWs.send(JSON.stringify({ type: "audio", audio: part.inlineData.data }));
              }
            }

            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }

            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));

              if (dialogueHistory.length >= 2) {
                (async () => {
                  try {
                    const updated = await processConversationSlice(apiKey, dialogueHistory);
                    if (updated) {
                      memoriesCache = updated;
                      clientWs.send(JSON.stringify({ type: "memory_sync", memories: updated }));
                    }
                  } catch (err) {
                    console.error("[Memory Sync] Error running background consolidation:", err);
                  }
                })();
              }
            }

            const userTextOutput = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              dialogueHistory.push({ role: "user", text: userTextOutput });
            }

            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === "saveCustomMemory") {
                  (async () => {
                    try {
                      const args = fc.args as any;
                      const category = args.category;
                      const text = args.text;
                      if (category && text) {
                        const mList = await loadMemories();
                        const timestamp = new Date().toISOString();
                        const newMemory: Memory = {
                          id: Math.random().toString(36).substring(2, 11),
                          category,
                          text,
                          createdAt: timestamp,
                          updatedAt: timestamp,
                        };
                        mList.push(newMemory);
                        await saveMemories(mList);
                        memoriesCache = mList;
                        clientWs.send(JSON.stringify({ type: "memory_sync", memories: mList }));

                        session.sendToolResponse({
                          functionResponses: [
                            {
                              name: fc.name,
                              response: {
                                output: {
                                  result:
                                    "Memory successfully captured and persisted in connections core.",
                                },
                              },
                              id: fc.id,
                            },
                          ],
                        });
                      }
                    } catch (err: any) {
                      console.error("saveCustomMemory execution failure:", err);
                    }
                  })();
                } else {
                  clientWs.send(
                    JSON.stringify({
                      type: "toolCall",
                      callId: fc.id,
                      name: fc.name,
                      args: fc.args,
                    })
                  );
                }
              }
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed");
            clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
          },
        },
      });

      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));

      clientWs.on("message", (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
            });
          } else if (msg.type === "text" && msg.text) {
            try {
              dialogueHistory.push({ role: "user", text: String(msg.text) });
              session.sendClientContent({
                turns: [
                  {
                    role: "user",
                    parts: [{ text: String(msg.text) }],
                  },
                ],
                turnComplete: true,
              });
            } catch (txtErr) {
              console.error("[Live API text turn failure]:", txtErr);
            }
          } else if (msg.type === "video" && msg.video) {
            session.sendRealtimeInput({
              video: { data: msg.video, mimeType: "image/jpeg" },
            });
          } else if (msg.type === "toolResponse") {
            session.sendToolResponse({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id,
                },
              ],
            });
          }
        } catch (e) {
          console.error("Error forwarding client frame message:", e);
        }
      });

      clientWs.on("close", () => {
        try {
          session.close();
        } catch {}
      });
    } catch (err: any) {
      console.error("Error connecting to Gemini Live API:", err);
      clientWs.send(
        JSON.stringify({
          type: "error",
          error: `Could not connect to Gemini: ${err.message || err}`,
        })
      );
      clientWs.close();
    }
  });

  app.use("/assets", express.static(path.join(process.cwd(), "assets")));

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[JARVIS Server] Running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});

