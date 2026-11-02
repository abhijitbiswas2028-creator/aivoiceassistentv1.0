const checks = [
  ["Node", process.version],
  ["Authorized project", process.env.JARVIS_ALLOWED_ROOT || process.cwd()],
  ["Browser connector", process.env.JARVIS_CHROME_CDP_URL ? "CDP configured" : "managed Playwright browser"],
  ["Gemini", process.env.GEMINI_API_KEY ? "configured" : "missing GEMINI_API_KEY"],
];
for (const [name, result] of checks) console.log(`${name}: ${result}`);
try {
  const response = await fetch("http://127.0.0.1:3001/api/status");
  console.log(`Local bridge: ${response.ok ? "connected" : "not connected"}`);
  if (response.ok) console.log(await response.json());
} catch { console.log("Local bridge: not running"); }
