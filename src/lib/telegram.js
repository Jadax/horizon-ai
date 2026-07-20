/**
 * TELEGRAM APPROVAL FLOW — when a job lands in "Awaiting Approval", send a
 * digest (title, score, duration, preview link) with one-tap Approve /
 * dashboard buttons, so approval works from a phone without opening the
 * dashboard. Uses Telegram's plain HTTPS Bot API — no SDK dependency.
 *
 * Setup (both free): message @BotFather → /newbot → TELEGRAM_BOT_TOKEN;
 * message the new bot once, then GET /getUpdates to find TELEGRAM_CHAT_ID.
 * Unset vars = feature silently off.
 */
import { config } from "../config.js";

export async function notifyAwaitingApproval({ jobId, title, score, duration, videoUrl }) {
  if (!config.telegram.botToken || !config.telegram.chatId) return;
  try {
    const base = config.telegram.publicUrl || `http://localhost:${config.port}`;
    const approveUrl = `${base}/api/jobs/${jobId}/approve?key=${encodeURIComponent(config.dashboardPassword)}`;
    const dashUrl = `${base}/?key=${encodeURIComponent(config.dashboardPassword)}`;
    const text = [
      `🎬 *New video awaiting approval*`,
      ``,
      `*${(title || "Untitled").replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1")}*`,
      `Quality: ${score ?? "?"}/100 · ${Math.round(duration || 0)}s`,
      ``,
      `[▶ Watch preview](${videoUrl})`,
    ].join("\n");
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Approve & schedule", url: approveUrl },
            { text: "🖥 Dashboard", url: dashUrl },
          ]],
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (!json.ok) console.warn("[telegram] sendMessage failed:", json.description);
  } catch (err) {
    // Notifications are never load-bearing — a Telegram outage must not
    // affect the pipeline.
    console.warn("[telegram] notify failed:", err.message);
  }
}
