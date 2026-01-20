import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import {
  ChatMessage,
  ToolUsage,
  generateReply,
  interpretMessage,
} from "./agent.js";
import { loadTradeLogConfig } from "./config.js";
import { appendTradeRow, readTrades } from "./sheets.js";
import { SummaryQuery } from "./types.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, "..", "..", "client", "dist");

const app = express();
app.use(cors());
app.use(express.json());

const config = loadTradeLogConfig();
const chatHistory: ChatMessage[] = [];
const MAX_HISTORY = 20;
const defaultTools: ToolUsage = {
  linkup: { status: "skipped", results: 0 },
};

function pushHistory(entry: ChatMessage) {
  chatHistory.push(entry);
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory.splice(0, chatHistory.length - MAX_HISTORY);
  }
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMoney(value: string): number {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeLine(line: string): string {
  return line.replace(/\*\*/g, "").replace(/^[-*•]+\s*/, "").trim();
}

function parseManualTrade(message: string) {
  const fields: Partial<{
    transactionType: "buy" | "sell";
    symbol: string;
    quantity: number;
    amountPerUnit: number;
    totalAmount: number;
    tradingFees: number;
    investmentAccount: string;
    date: string;
  }> = {};

  const lines = message
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  lines.forEach((line) => {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) {
      return;
    }
    const label = match[1].trim().toLowerCase();
    const value = match[2].trim();

    if (label.includes("transaction type")) {
      fields.transactionType = value.toLowerCase().includes("sell")
        ? "sell"
        : "buy";
      return;
    }
    if (label.includes("stock") || label.includes("symbol")) {
      fields.symbol = value.toUpperCase();
      return;
    }
    if (label.includes("quantity")) {
      fields.quantity = parseMoney(value);
      return;
    }
    if (label.includes("amount per unit") || label.includes("price per unit")) {
      fields.amountPerUnit = parseMoney(value);
      return;
    }
    if (label.includes("total amount")) {
      fields.totalAmount = parseMoney(value);
      return;
    }
    if (label.includes("trading fees") || label === "fees") {
      fields.tradingFees = parseMoney(value);
      return;
    }
    if (label.includes("investment account") || label === "account") {
      fields.investmentAccount = value;
      return;
    }
    if (label === "date") {
      fields.date = value;
    }
  });

  return fields;
}

function getMissingManualFields(fields: ReturnType<typeof parseManualTrade>) {
  const missing: string[] = [];
  if (!fields.transactionType) missing.push("Transaction Type");
  if (!fields.symbol) missing.push("Stock/ETF Symbol");
  if (!fields.quantity) missing.push("Quantity of Units");
  if (!fields.amountPerUnit) missing.push("Amount per unit");
  if (!fields.date) missing.push("Date");
  if (!fields.totalAmount) missing.push("Total Amount (before fees)");
  if (fields.tradingFees === undefined) missing.push("Trading Fees");
  if (!fields.investmentAccount) missing.push("Investment Account");
  return missing;
}

function isLlmAuthError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Missing OPENAI_API_KEY") ||
    message.includes("Incorrect API key") ||
    message.includes("invalid_api_key") ||
    message.includes("API key expired") ||
    message.includes("API_KEY_INVALID")
  );
}

function manualTradePrompt(missing?: string[]): string {
  const missingText =
    missing && missing.length
      ? `Missing: ${missing.join(", ")}. `
      : "I couldn't parse all required fields. ";
  return (
    "I can't reach the AI right now (API key issue). " +
    missingText +
    "You can still log a trade by sending details in this format:\n" +
    "- Transaction Type: buy\n" +
    "- Stock/ETF Symbol: SPUS\n" +
    "- Quantity of Units: 10\n" +
    "- Amount per unit: 55.00\n" +
    "- Date: 01-20-2026\n" +
    "- Total Amount (before fees): 550.00\n" +
    "- Trading Fees: 0\n" +
    "- Investment Account: Brokerage 1"
  );
}

function manualTradeConfirmation(trade: {
  transactionType: "buy" | "sell";
  symbol: string;
  quantity: number;
  amountPerUnit: number;
  totalAmount: number;
  tradingFees: number;
  investmentAccount: string;
  date: string;
}): string {
  return (
    "Logged trade manually:\n" +
    `- Transaction Type: ${trade.transactionType}\n` +
    `- Stock/ETF Symbol: ${trade.symbol}\n` +
    `- Quantity of Units: ${trade.quantity}\n` +
    `- Amount per unit: ${trade.amountPerUnit}\n` +
    `- Date: ${trade.date}\n` +
    `- Total Amount (before fees): ${trade.totalAmount}\n` +
    `- Trading Fees: ${trade.tradingFees}\n` +
    `- Investment Account: ${trade.investmentAccount}`
  );
}

function summarizeTrades(rows: Record<string, string>[], query: SummaryQuery) {
  const symbolKey = config.columns.symbol;
  const typeKey = config.columns.transactionType;
  const qtyKey = config.columns.quantity;
  const amountKey = config.columns.amountPerUnit;
  const totalKey = config.columns.totalAmount;
  const dateKey = config.columns.date;

  const filtered = rows.filter((row) => {
    const hasValues = Object.values(row).some((value) =>
      String(value ?? "").trim()
    );
    if (!hasValues) {
      return false;
    }
    if (query.symbol) {
      const symbol = (row[symbolKey] ?? "").toUpperCase();
      if (symbol !== query.symbol.toUpperCase()) {
        return false;
      }
    }

    if (dateKey && (query.startDate || query.endDate)) {
      const rowDate = parseDate(row[dateKey]);
      if (!rowDate) {
        return false;
      }
      const start = parseDate(query.startDate);
      const end = parseDate(query.endDate);
      if (start && rowDate < start) {
        return false;
      }
      if (end && rowDate > end) {
        return false;
      }
    }

    return true;
  });

  if (!filtered.length) {
    return "No trades found for that filter.";
  }

  const summary = new Map<
    string,
    {
      buyQty: number;
      buyValue: number;
      sellQty: number;
      sellValue: number;
      otherCount: number;
      otherTypes: Set<string>;
    }
  >();

  filtered.forEach((row) => {
    const symbol = (row[symbolKey] ?? "UNKNOWN").toUpperCase();
    const rawSide = (row[typeKey] ?? "").trim().toLowerCase();
    const qty = parseMoney(row[qtyKey] ?? "");
    const amountPerUnit = parseMoney(row[amountKey] ?? "");
    const totalAmount =
      parseMoney(row[totalKey] ?? "") || amountPerUnit * qty;
    const entry =
      summary.get(symbol) ?? {
        buyQty: 0,
        buyValue: 0,
        sellQty: 0,
        sellValue: 0,
        otherCount: 0,
        otherTypes: new Set<string>(),
      };

    if (rawSide.startsWith("buy")) {
      entry.buyQty += qty;
      entry.buyValue += totalAmount;
    } else if (rawSide.startsWith("sell")) {
      entry.sellQty += qty;
      entry.sellValue += totalAmount;
    } else if (rawSide) {
      entry.otherCount += 1;
      entry.otherTypes.add(row[typeKey] ?? "Other");
    }

    summary.set(symbol, entry);
  });

  const lines = Array.from(summary.entries()).map(([symbol, entry]) => {
    const buyAvg =
      entry.buyQty > 0 ? (entry.buyValue / entry.buyQty).toFixed(2) : "0.00";
    const sellAvg =
      entry.sellQty > 0 ? (entry.sellValue / entry.sellQty).toFixed(2) : "0.00";
    const extras =
      entry.otherCount > 0
        ? `, other ${entry.otherCount} (${Array.from(entry.otherTypes).join(
            ", "
          )})`
        : "";
    return `${symbol}: buy ${entry.buyQty} @ avg ${buyAvg}, sell ${entry.sellQty} @ avg ${sellAvg}${extras}`;
  });

  return `Total trades: ${filtered.length}.\n${lines.join("\n")}`;
}

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    return res.status(400).json({ reply: "Message is required." });
  }

  try {
    let action;
    try {
      action = await interpretMessage(message, chatHistory);
    } catch (error) {
      if (isLlmAuthError(error)) {
        const manualFields = parseManualTrade(message);
        const missing = getMissingManualFields(manualFields);
        if (!missing.length) {
          const trade = {
            transactionType: manualFields.transactionType!,
            symbol: manualFields.symbol!,
            quantity: manualFields.quantity!,
            amountPerUnit: manualFields.amountPerUnit!,
            totalAmount:
              manualFields.totalAmount ??
              manualFields.quantity! * manualFields.amountPerUnit!,
            tradingFees: manualFields.tradingFees ?? 0,
            investmentAccount: manualFields.investmentAccount!,
            date: manualFields.date!,
          };
          await appendTradeRow(trade, config);
          const reply = manualTradeConfirmation(trade);
          pushHistory({ role: "user", content: message });
          pushHistory({ role: "assistant", content: reply });
          return res.json({ reply, tools: defaultTools });
        }
        return res
          .status(503)
          .json({ reply: manualTradePrompt(missing), tools: defaultTools });
      }
      throw error;
    }

    if (action.action === "log_trade" && action.trade) {
      await appendTradeRow(action.trade, config);
      const { reply, tools } = await generateReply(
        message,
        {
          action: "log_trade",
          trade: action.trade,
        },
        chatHistory
      );
      pushHistory({ role: "user", content: message });
      pushHistory({ role: "assistant", content: reply });
      return res.json({ reply, tools });
    }

    if (action.action === "summarize") {
      const trades = await readTrades(config);
      const summary = summarizeTrades(trades, action.summary ?? {});
      const { reply, tools } = await generateReply(
        message,
        {
          action: "summarize",
          summary: action.summary ?? {},
          summaryText: summary,
        },
        chatHistory
      );
      pushHistory({ role: "user", content: message });
      pushHistory({ role: "assistant", content: reply });
      return res.json({ reply, tools });
    }

    const { reply, tools } = await generateReply(
      message,
      { action: "unknown" },
      chatHistory
    );
    pushHistory({ role: "user", content: message });
    pushHistory({ role: "assistant", content: reply });
    return res.json({ reply, tools });
  } catch (error) {
    console.error(error);
    const errorMessage =
      error instanceof Error ? error.message : "Unexpected server error.";
    if (isLlmAuthError(errorMessage)) {
      const manualFields = parseManualTrade(message);
      const missing = getMissingManualFields(manualFields);
      if (!missing.length) {
        const trade = {
          transactionType: manualFields.transactionType!,
          symbol: manualFields.symbol!,
          quantity: manualFields.quantity!,
          amountPerUnit: manualFields.amountPerUnit!,
          totalAmount:
            manualFields.totalAmount ??
            manualFields.quantity! * manualFields.amountPerUnit!,
          tradingFees: manualFields.tradingFees ?? 0,
          investmentAccount: manualFields.investmentAccount!,
          date: manualFields.date!,
        };
        await appendTradeRow(trade, config);
        const reply = manualTradeConfirmation(trade);
        pushHistory({ role: "user", content: message });
        pushHistory({ role: "assistant", content: reply });
        return res.json({ reply, tools: defaultTools });
      }
      return res
        .status(503)
        .json({ reply: manualTradePrompt(missing), tools: defaultTools });
    }
    try {
      const { reply, tools } = await generateReply(
        message,
        { error: errorMessage },
        chatHistory
      );
      pushHistory({ role: "user", content: message });
      pushHistory({ role: "assistant", content: reply });
      return res.status(500).json({ reply, tools });
    } catch {
      return res
        .status(500)
        .json({ reply: errorMessage, tools: defaultTools });
    }
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
