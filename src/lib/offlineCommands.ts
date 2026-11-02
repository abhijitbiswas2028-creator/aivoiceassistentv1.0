type LocalAction = { type: string; args: Record<string, unknown> };

function calculate(raw: string): string | null {
  const expression = raw
    .toLowerCase()
    .replace(/multiplied by|times/g, "*")
    .replace(/divided by/g, "/")
    .replace(/plus/g, "+")
    .replace(/minus/g, "-")
    .replace(/[^0-9+*/().\s-]/g, "");
  if (!expression || !/^[0-9+*/().\s-]+$/.test(expression)) return null;
  try {
    const value = Function(`"use strict"; return (${expression})`)();
    return Number.isFinite(value) ? String(value) : null;
  } catch { return null; }
}

export function interpretOfflineCommand(transcript: string): { reply: string; action?: LocalAction } {
  const text = transcript.trim().toLowerCase();
  if (/what can you do|capabilities|help/.test(text)) {
    return { reply: "I can open and search websites, control supported browser tabs and YouTube, open VS Code, manage authorized project files, and run controlled development commands. Advanced natural conversation needs your Gemini provider key." };
  }
  const math = text.match(/(?:calculate|what is)\s+(.+)/);
  if (math) {
    const value = calculate(math[1]);
    if (value) return { reply: `The answer is ${value}.` };
  }
  const youtubeSearch = text.match(/search youtube for\s+(.+)/);
  if (youtubeSearch) return { reply: `Searching YouTube for ${youtubeSearch[1]}.`, action: { type: "browserSearch", args: { query: youtubeSearch[1], engine: "youtube" } } };
  const webSearch = text.match(/(?:search(?: the web)? for|google)\s+(.+)/);
  if (webSearch) return { reply: `Searching for ${webSearch[1]}.`, action: { type: "browserSearch", args: { query: webSearch[1] } } };
  if (/open youtube/.test(text)) return { reply: "Opening YouTube.", action: { type: "browserOpen", args: { url: "youtube" } } };
  const site = text.match(/^open\s+([a-z0-9.-]+\.(?:com|org|net|io|dev|ai)(?:\/\S*)?)$/);
  if (site) return { reply: `Opening ${site[1]}.`, action: { type: "browserOpen", args: { url: site[1] } } };
  if (/open (?:vs code|vscode|code editor)/.test(text)) return { reply: "Opening VS Code.", action: { type: "desktopAppControl", args: { appName: "vscode", action: "open" } } };
  if (/open (?:notes|text editor)/.test(text)) return { reply: "Opening VS Code for notes.", action: { type: "desktopAppControl", args: { appName: "notes", action: "open" } } };
  if (/list (?:files|folder|project files)/.test(text)) return { reply: "Listing the authorized project files.", action: { type: "fileOperation", args: { operation: "list", path: "." } } };
  return { reply: "I need your Gemini provider for that natural-language request. You can still ask me to open YouTube, search the web, open VS Code, list project files, or calculate an expression." };
}

export async function runOfflineCommand(transcript: string): Promise<string> {
  const command = interpretOfflineCommand(transcript);
  if (!command.action) return command.reply;
  try {
    const response = await fetch("/api/system/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.action) });
    const payload = await response.json();
    return response.ok ? payload.result || command.reply : payload.error || "That action could not be completed.";
  } catch { return "The local JARVIS bridge is unavailable."; }
}
