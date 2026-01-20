import OpenAI from "openai";
import { z } from "zod";
import { SummaryQuery, TradeInput } from "./types.js";

const responseSchema = z.object({
  action: z.enum(["log_trade", "summarize", "unknown"]),
  trade: z
    .object({
      date: z.string(),
      transactionType: z.enum(["buy", "sell"]),
      symbol: z.string(),
      quantity: z.number(),
      amountPerUnit: z.number(),
      totalAmount: z.number(),
      tradingFees: z.number(),
      investmentAccount: z.string(),
    })
    .nullable()
    .optional(),
  summary: z
    .object({
      symbol: z.string().nullable().optional(),
      startDate: z.string().nullable().optional(),
      endDate: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const systemPrompt = `
You are a trading assistant connected to a Google Sheet named "Trade Log".
Return ONLY valid JSON with these fields:
- action: "log_trade" | "summarize" | "unknown"
- trade: object {
  date (MM-DD-YYYY),
  transactionType (buy or sell),
  symbol,
  quantity,
  amountPerUnit,
  totalAmount,
  tradingFees,
  investmentAccount
} or null
- summary: object { symbol, startDate, endDate } or null

Rules:
- Use "buy" or "sell" for transactionType.
- quantity, amountPerUnit, totalAmount, tradingFees must be numbers.
- If the user does not provide all trade fields, set action to "unknown".
- If the user asks for a summary, set action to "summarize".
- If the user wants to log a trade, set action to "log_trade".
- If unclear, use "unknown".
`;

const replySystemPrompt = `
You are a helpful trading assistant. Respond naturally to the user.
If context JSON is provided, use it to craft a helpful response.
If web search results are provided, use them for up-to-date info and cite the URL in parentheses.
If action is "summarize", explain the summary in plain language.
If action is "log_trade", confirm what was logged.
If action is "unknown", ask a brief clarifying question.
Required trade fields:
- Date (MM-DD-YYYY)
- Transaction Type (buy or sell)
- Stock / ETF Symbol
- Quantity of Units
- Amount per unit
- Total Amount (before trading fees)
- Trading Fees
- Investment Account
Keep responses concise.
`;

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

function formatHistory(history: ChatMessage[] | undefined): string {
  if (!history?.length) {
    return "";
  }
  return history
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join("\n");
}

const defaultModel = "gpt-4o-mini";

function getOpenAiModel(): string {
  return process.env.OPENAI_MODEL?.trim() || defaultModel;
}

type LinkupSearchResult = {
  name?: string;
  url?: string;
  content?: string;
};

type LinkupSearchResponse = {
  results?: LinkupSearchResult[];
};

export type ToolUsage = {
  linkup: {
    status: "used" | "attempted" | "not_configured" | "error" | "skipped";
    results: number;
  };
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
}

export async function interpretMessage(
  message: string,
  history?: ChatMessage[]
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const client = new OpenAI({ apiKey });
  const historyText = formatHistory(history);
  const prompt = `${systemPrompt}\nConversation:\n${historyText}\nUser message: ${message}`;
  const result = await client.chat.completions.create({
    model: getOpenAiModel(),
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
    try {
      payload = JSON.parse(jsonText);
    } catch {
      payload = {};
    }
  }
  const parsed = responseSchema.safeParse(payload);

  if (!parsed.success) {
    return { action: "unknown" as const };
  }

  return parsed.data as {
    action: "log_trade" | "summarize" | "unknown";
    trade?: TradeInput | null;
    summary?: SummaryQuery | null;
  };
}

export async function generateReply(
  message: string,
  context?: {
    action?: "log_trade" | "summarize" | "unknown";
    trade?: TradeInput | null;
    summary?: SummaryQuery | null;
    summaryText?: string | null;
    error?: string | null;
  },
  history?: ChatMessage[]
): Promise<{ reply: string; tools: ToolUsage }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const client = new OpenAI({ apiKey });
  let webSearchPayload: string | null = null;
  const tools: ToolUsage = {
    linkup: {
      status: "skipped",
      results: 0,
    },
  };
  try {
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
  } catch {
    webSearchPayload = null;
    tools.linkup.status = "error";
  }
  const payload = context ? JSON.stringify(context) : "";
  const historyText = formatHistory(history);
  const prompt = `${replySystemPrompt}\nConversation:\n${historyText}\nContext JSON: ${payload}\nWeb search JSON: ${webSearchPayload ?? ""}\nUser message: ${message}`;
  const result = await client.chat.completions.create({
    model: getOpenAiModel(),
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
