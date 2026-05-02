import { Router, Request, Response } from "express";

export const botRouter = Router();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// POST /api/bot/webhook
// Register this URL in Telegram:
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-backend.com/api/bot/webhook
botRouter.post("/webhook", (req: Request, res: Response) => {
  const update = req.body;
  console.log("Telegram update received:", JSON.stringify(update, null, 2));

  // TODO: handle bot commands here
  // e.g. if (update.message?.text === '/start') { ... }

  res.sendStatus(200);
});

// GET /api/bot/info — verify bot token is working
botRouter.get("/info", async (_req: Request, res: Response) => {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getMe`,
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Telegram API" });
  }
});
