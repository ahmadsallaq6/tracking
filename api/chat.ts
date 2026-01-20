import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { google } from "googleapis";
import { z } from "zod";

// ============ Types ============
type TradeInput = {
  date: string;
  transactionType: "buy" | "sell";
  symbol: string;
  quantity: number;
  amountPerUnit: number;
  totalAmount: number;
  tradingFees: number;
  investmentAccount: string;
};

type SummaryQuery = {
  symbol?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};

type TradeLogConfig = {
  sheetName: string;
  headerRow: number;
  dataStartRow?: number;
  columns: {
    date?: string;
    transactionType?: string;
    symbol?: string;
    quantity?: string;
    amountPerUnit?: string;
    totalAmount?: string;
    tradingFees?: string;
    investmentAccount?: string;
  };
};

type ToolStatus = "used" | "attempted" | "not_configured" | "error" | "skipped";

type ToolUsage = {
  linkup: {
    status: ToolStatus;
    results: number;
  };
};

// ============ Config ============
const config: TradeLogConfig = {
  sheetName: "Trade Log",
  headerRow: 7,
  dataStartRow: 8,
  columns: {
    date: "Date (MM-DD-YYYY)",
    transactionType: "Transaction Type",
    symbol: "Stock / ETF Symbol",
    quantity: "Quantity of Units",
    amountPerUnit: "Amount per unit",
    totalAmount: "Total Amount (before trading fees)",
    tradingFees: "Trading Fees",
    investmentAccount: "Investment Account"
  }
};

// ============ Sheets ============
type HeaderIndex = Record<string, number>;
type SheetsContext = {
  sheets: ReturnType<typeof google.sheets>;
  clientEmail: string;
};

const DEFAULT_INVESTMENT_ACCOUNT = "Interactive Brokers (IBKR)";
const VALID_TRANSACTION_TYPES = new Set([
  "Buy", "Sell", "Dividend", "Split", "Return of capital",
  "Cost Base Adj.", "Reinvested capital gain distribution",
]);

function normalizeTransactionType(input: string): string {
  const trimmed = input.trim();
  for (const value of VALID_TRANSACTION_TYPES) {
    if (value.toLowerCase() === trimmed.toLowerCase()) return value;
  }
  return trimmed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function getSheetsContext(): SheetsContext {
  const clientEmail = requireEnv("GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL");
  const privateKey = requireEnv("GOOGLE_SHEETS_PRIVATE_KEY").replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), clientEmail };
}

async function getHeaderIndex(context: SheetsContext, spreadsheetId: string, cfg: TradeLogConfig): Promise<HeaderIndex> {
  const range = `${cfg.sheetName}!${cfg.headerRow}:${cfg.headerRow}`;
  const response = await context.sheets.spreadsheets.values.get({ spreadsheetId, range });
  const headers = response.data.values?.[0] ?? [];
  const index: HeaderIndex = {};
  headers.forEach((header: unknown, i: number) => {
    if (typeof header === "string" && header.trim()) index[header.trim()] = i;
  });
  return index;
}

async function getSheetProperties(
  context: SheetsContext,
  spreadsheetId: string,
  sheetName: string
): Promise<{ sheetId: number; rowCount: number; columnCount: number }> {
  const response = await context.sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
  });

  const sheet = response.data.sheets?.find(
    (entry) => entry.properties?.title === sheetName
  );
  const properties = sheet?.properties;
  const grid = properties?.gridProperties;

  if (!properties?.sheetId || !grid) {
    throw new Error(`Sheet '${sheetName}' not found in spreadsheet ${spreadsheetId}.`);
  }

  return {
    sheetId: properties.sheetId,
    rowCount: grid.rowCount ?? 0,
    columnCount: grid.columnCount ?? 0,
  };
}

async function ensureSheetCapacity(
  context: SheetsContext,
  spreadsheetId: string,
  sheetName: string,
  minRows: number,
  minColumns: number
): Promise<void> {
  const { sheetId, rowCount, columnCount } = await getSheetProperties(
    context,
    spreadsheetId,
    sheetName
  );

  const targetRows = Math.max(rowCount, minRows + 10); // Add buffer
  const targetColumns = Math.max(columnCount, minColumns);

  if (targetRows === rowCount && targetColumns === columnCount) {
    return;
  }

  await context.sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                rowCount: targetRows,
                columnCount: targetColumns,
              },
            },
            fields: "gridProperties(rowCount,columnCount)",
          },
        },
      ],
    },
  });
}

function buildRow(trade: TradeInput, headerIndex: HeaderIndex, cfg: TradeLogConfig): string[] {
  const normalizedType = normalizeTransactionType(trade.transactionType);
  const totalAmount = Number.isFinite(trade.totalAmount) && trade.totalAmount !== 0
    ? trade.totalAmount : trade.quantity * trade.amountPerUnit;
  
  const entries: Array<[string | undefined, string | number | null | undefined]> = [
    [cfg.columns.date, trade.date],
    [cfg.columns.transactionType, normalizedType],
    [cfg.columns.symbol, trade.symbol],
    [cfg.columns.quantity, trade.quantity],
    [cfg.columns.amountPerUnit, trade.amountPerUnit],
    [cfg.columns.totalAmount, totalAmount],
    [cfg.columns.tradingFees, trade.tradingFees],
    [cfg.columns.investmentAccount, DEFAULT_INVESTMENT_ACCOUNT],
  ];

  const indices = entries
    .map(([header]) => (header ? headerIndex[header] : undefined))
    .filter((value): value is number => typeof value === "number");

  if (!indices.length) throw new Error("No matching headers found. Check column names.");
  const maxIndex = Math.max(...indices);
  const row = new Array(maxIndex + 1).fill("");

  entries.forEach(([header, value]) => {
    if (!header) return;
    const idx = headerIndex[header];
    if (typeof idx === "number") row[idx] = value === null || value === undefined ? "" : String(value);
  });

  return row;
}

async function appendTradeRow(trade: TradeInput, cfg: TradeLogConfig): Promise<void> {
  const context = getSheetsContext();
  const spreadsheetId = requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const headerIndex = await getHeaderIndex(context, spreadsheetId, cfg);
  const row = buildRow(trade, headerIndex, cfg);
  const dataStartRow = cfg.dataStartRow ?? cfg.headerRow + 1;

  const existing = await context.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${cfg.sheetName}!A${dataStartRow}:ZZ`,
  });
  const rows = (existing.data.values ?? []) as string[][];

  const firstEmptyIndex = rows.findIndex(
    (existingRow) => !existingRow?.some((cell) => String(cell ?? "").trim())
  );
  const targetRow = dataStartRow + (firstEmptyIndex === -1 ? rows.length : firstEmptyIndex);

  // Ensure sheet has enough rows before writing
  await ensureSheetCapacity(
    context,
    spreadsheetId,
    cfg.sheetName,
    targetRow,
    row.length
  );

  await context.sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${cfg.sheetName}!A${targetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function readTrades(cfg: TradeLogConfig): Promise<Record<string, string>[]> {
  const context = getSheetsContext();
  const spreadsheetId = requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const headerIndex = await getHeaderIndex(context, spreadsheetId, cfg);
  const headers = Object.entries(headerIndex).sort((a, b) => a[1] - b[1]);
  const dataStartRow = cfg.dataStartRow ?? cfg.headerRow + 1;

  const response = await context.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${cfg.sheetName}!A${dataStartRow}:ZZ`,
  });
  const rows = response.data.values ?? [];

  return rows.map((row: Array<string | number | null | undefined>) => {
    const entry: Record<string, string> = {};
    headers.forEach(([header, idx]) => { entry[header] = row[idx] ? String(row[idx]) : ""; });
    return entry;
  });
}

// ============ Linkup Search ============
type LinkupSearchResult = {
  name?: string;
  url?: string;
  content?: string;
};

type LinkupSearchResponse = {
  results?: LinkupSearchResult[];
};

type LinkupSearchOutcome = {
  status: "not_configured" | "error" | "ok";
  payload?: LinkupSearchResponse;
};

function shouldUseWebSearch(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("price") ||
    text.includes("quote") ||
    text.includes("stock price") ||
    text.includes("current price") ||
    text.includes("market price")
  );
}

async function fetchLinkupSearch(query: string): Promise<LinkupSearchOutcome> {
  const apiKey = process.env.LINKUP_API_KEY?.trim();
  if (!apiKey) {
    return { status: "not_configured" };
  }

  try {
    const response = await fetch("https://api.linkup.so/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        depth: "standard",
        outputType: "searchResults",
        maxResults: 5,
      }),
    });

    if (!response.ok) {
      return { status: "error" };
    }

    const payload = (await response.json()) as LinkupSearchResponse;
    return { status: "ok", payload };
  } catch {
    return { status: "error" };
  }
}

// ============ Agent ============
const responseSchema = z.object({
  action: z.enum(["log_trade", "summarize", "unknown"]),
  trade: z.object({
    date: z.string(),
    transactionType: z.enum(["buy", "sell"]),
    symbol: z.string(),
    quantity: z.number(),
    amountPerUnit: z.number(),
    totalAmount: z.number(),
    tradingFees: z.number(),
    investmentAccount: z.string(),
  }).nullable().optional(),
  summary: z.object({
    symbol: z.string().nullable().optional(),
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
  }).nullable().optional(),
});

const systemPrompt = `You are a trading assistant connected to a Google Sheet named "Trade Log".
Return ONLY valid JSON with these fields:
- action: "log_trade" | "summarize" | "unknown"
- trade: object { date (MM-DD-YYYY), transactionType (buy or sell), symbol, quantity, amountPerUnit, totalAmount, tradingFees, investmentAccount } or null
- summary: object { symbol, startDate, endDate } or null

Rules:
- Use "buy" or "sell" for transactionType.
- quantity, amountPerUnit, totalAmount, tradingFees must be numbers.
- If the user does not provide all trade fields, set action to "unknown".
- If the user asks for a summary, set action to "summarize".
- If the user wants to log a trade, set action to "log_trade".
- If unclear, use "unknown".`;

const replySystemPrompt = `You are a helpful trading assistant. Respond naturally to the user.
If context JSON is provided, use it to craft a helpful response.
If web search results are provided, use them for up-to-date info and cite the URL in parentheses.
If action is "summarize", explain the summary in plain language.
If action is "log_trade", confirm what was logged.
If action is "unknown", ask a brief clarifying question.
Required trade fields: Date, Transaction Type, Stock/ETF Symbol, Quantity, Amount per unit, Total Amount, Trading Fees, Investment Account.
Keep responses concise.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

function formatHistory(history: ChatMessage[] | undefined): string {
  if (!history?.length) return "";
  return history.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
}

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

async function interpretMessage(message: string, history?: ChatMessage[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const client = new OpenAI({ apiKey });
  const historyText = formatHistory(history);
  const prompt = `${systemPrompt}\nConversation:\n${historyText}\nUser message: ${message}`;
  
  const result = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a precise JSON generator." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
  });
  
  const response = result.choices[0]?.message?.content ?? "";
  const jsonText = extractJson(response);
  let payload: unknown = {};
  if (jsonText) {
    try { payload = JSON.parse(jsonText); } catch { payload = {}; }
  }
  
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) return { action: "unknown" as const };
  return parsed.data as { action: "log_trade" | "summarize" | "unknown"; trade?: TradeInput | null; summary?: SummaryQuery | null; };
}

async function generateReply(
  message: string,
  context: { action?: string; trade?: TradeInput | null; summary?: SummaryQuery | null; summaryText?: string | null; error?: string | null; },
  history: ChatMessage[] | undefined,
  tools: ToolUsage
): Promise<{ reply: string; tools: ToolUsage }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const client = new OpenAI({ apiKey });
  
  // Try web search if applicable
  let webSearchPayload: string | null = null;
  if (shouldUseWebSearch(message)) {
    const search = await fetchLinkupSearch(message);
    if (search.status === "not_configured") {
      tools.linkup.status = "not_configured";
    } else if (search.status === "error") {
      tools.linkup.status = "error";
    } else {
      const results = search.payload?.results ?? [];
      tools.linkup.results = results.length;
      tools.linkup.status = results.length ? "used" : "attempted";
      if (results.length) {
        webSearchPayload = JSON.stringify(search.payload);
      }
    }
  }

  const payload = context ? JSON.stringify(context) : "";
  const historyText = formatHistory(history);
  const prompt = `${replySystemPrompt}\nConversation:\n${historyText}\nContext JSON: ${payload}\nWeb search JSON: ${webSearchPayload ?? ""}\nUser message: ${message}`;
  
  const result = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
  });
  
  return {
    reply: result.choices[0]?.message?.content?.trim() ?? "",
    tools,
  };
}

// ============ Helpers ============
function parseMoney(value: string): number {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function summarizeTrades(rows: Record<string, string>[], query: SummaryQuery) {
  const symbolKey = config.columns.symbol!;
  const typeKey = config.columns.transactionType!;
  const qtyKey = config.columns.quantity!;
  const amountKey = config.columns.amountPerUnit!;
  const totalKey = config.columns.totalAmount!;
  const dateKey = config.columns.date!;

  const filtered = rows.filter((row) => {
    const hasValues = Object.values(row).some((value) => String(value ?? "").trim());
    if (!hasValues) return false;
    if (query.symbol) {
      const symbol = (row[symbolKey] ?? "").toUpperCase();
      if (symbol !== query.symbol.toUpperCase()) return false;
    }
    if (dateKey && (query.startDate || query.endDate)) {
      const rowDate = parseDate(row[dateKey]);
      if (!rowDate) return false;
      const start = parseDate(query.startDate);
      const end = parseDate(query.endDate);
      if (start && rowDate < start) return false;
      if (end && rowDate > end) return false;
    }
    return true;
  });

  if (!filtered.length) return "No trades found for that filter.";

  const summary = new Map<string, { buyQty: number; buyValue: number; sellQty: number; sellValue: number; }>();

  filtered.forEach((row) => {
    const symbol = (row[symbolKey] ?? "UNKNOWN").toUpperCase();
    const rawSide = (row[typeKey] ?? "").trim().toLowerCase();
    const qty = parseMoney(row[qtyKey] ?? "");
    const amountPerUnit = parseMoney(row[amountKey] ?? "");
    const totalAmount = parseMoney(row[totalKey] ?? "") || amountPerUnit * qty;
    const entry = summary.get(symbol) ?? { buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0 };

    if (rawSide.startsWith("buy")) { entry.buyQty += qty; entry.buyValue += totalAmount; }
    else if (rawSide.startsWith("sell")) { entry.sellQty += qty; entry.sellValue += totalAmount; }
    summary.set(symbol, entry);
  });

  const lines = Array.from(summary.entries()).map(([symbol, entry]) => {
    const buyAvg = entry.buyQty > 0 ? (entry.buyValue / entry.buyQty).toFixed(2) : "0.00";
    const sellAvg = entry.sellQty > 0 ? (entry.sellValue / entry.sellQty).toFixed(2) : "0.00";
    return `${symbol}: buy ${entry.buyQty} @ avg ${buyAvg}, sell ${entry.sellQty} @ avg ${sellAvg}`;
  });

  return `Total trades: ${filtered.length}.\n${lines.join("\n")}`;
}

const chatHistory: ChatMessage[] = [];
const MAX_HISTORY = 20;

function pushHistory(entry: ChatMessage) {
  chatHistory.push(entry);
  if (chatHistory.length > MAX_HISTORY) chatHistory.splice(0, chatHistory.length - MAX_HISTORY);
}

const defaultTools: ToolUsage = {
  linkup: { status: "skipped", results: 0 },
};

// ============ Handler ============
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ reply: "Message is required.", tools: defaultTools });

  try {
    const action = await interpretMessage(message, chatHistory);
    const tools: ToolUsage = { linkup: { status: "skipped", results: 0 } };

    if (action.action === "log_trade" && action.trade) {
      await appendTradeRow(action.trade, config);
      const { reply, tools: updatedTools } = await generateReply(
        message,
        { action: "log_trade", trade: action.trade },
        chatHistory,
        tools
      );
      pushHistory({ role: "user", content: message });
      pushHistory({ role: "assistant", content: reply });
      return res.json({ reply, tools: updatedTools });
    }

    if (action.action === "summarize") {
      const trades = await readTrades(config);
      const summary = summarizeTrades(trades, action.summary ?? {});
      const { reply, tools: updatedTools } = await generateReply(
        message,
        { action: "summarize", summary: action.summary ?? {}, summaryText: summary },
        chatHistory,
        tools
      );
      pushHistory({ role: "user", content: message });
      pushHistory({ role: "assistant", content: reply });
      return res.json({ reply, tools: updatedTools });
    }

    const { reply, tools: updatedTools } = await generateReply(
      message,
      { action: "unknown" },
      chatHistory,
      tools
    );
    pushHistory({ role: "user", content: message });
    pushHistory({ role: "assistant", content: reply });
    return res.json({ reply, tools: updatedTools });
  } catch (error) {
    console.error(error);
    const errorMessage = error instanceof Error ? error.message : "Unexpected server error.";
    return res.status(500).json({ reply: errorMessage, tools: defaultTools });
  }
}
