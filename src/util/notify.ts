import { execFile } from "node:child_process";

/** Escapa uma string para um literal AppleScript ("..."). */
function appleStr(s: string): string {
  const t = String(s).slice(0, 220).replace(/\s+/g, " ").trim();
  return '"' + t.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Notificação nativa best-effort (macOS via osascript). Nunca lança e não
 * bloqueia — é só um aviso. Em outros SOs vira no-op por enquanto.
 */
export function notify(title: string, body: string, subtitle?: string): void {
  if (process.platform !== "darwin") return;
  if (process.env.CARDUME_NOTIFY === "0") return;
  const sub = subtitle ? ` subtitle ${appleStr(subtitle)}` : "";
  const script = `display notification ${appleStr(body)} with title ${appleStr(title)}${sub} sound name "Ping"`;
  try {
    execFile("osascript", ["-e", script], () => {
      /* best-effort: ignora falhas */
    });
  } catch {
    /* ignora */
  }
}
