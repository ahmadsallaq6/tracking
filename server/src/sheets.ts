import { google } from "googleapis";
import { TradeInput, TradeLogConfig } from "./types.js";

type HeaderIndex = Record<string, number>;

type SheetsContext = {
  sheets: ReturnType<typeof google.sheets>;
  clientEmail: string;
};

const DEFAULT_INVESTMENT_ACCOUNT = "Interactive Brokers (IBKR)";
const VALID_TRANSACTION_TYPES = new Set([
  "Buy",
  "Sell",
  "Dividend",
  "Split",
  "Return of capital",
  "Cost Base Adj.",
  "Reinvested capital gain distribution",
]);

function normalizeTransactionType(input: string): string {
  const trimmed = input.trim();
  for (const value of VALID_TRANSACTION_TYPES) {
    if (value.toLowerCase() === trimmed.toLowerCase()) {
      return value;
    }
  }
  return trimmed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
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

  return {
    sheets: google.sheets({ version: "v4", auth }),
    clientEmail,
  };
}

function formatSheetsError(
  error: unknown,
  spreadsheetId: string,
  clientEmail: string,
  action: string
): Error {
  const err = error as {
    status?: number;
    code?: number;
    response?: { status?: number; data?: { error?: { status?: string; message?: string } } };
    message?: string;
  };
  const status = err?.status ?? err?.code ?? err?.response?.status;
  const apiStatus = err?.response?.data?.error?.status;
  const apiMessage = err?.response?.data?.error?.message;

  if (status === 403 || apiStatus === "PERMISSION_DENIED") {
    return new Error(
      `Google Sheets permission denied while ${action} for spreadsheet ${spreadsheetId}. ` +
        `Share the sheet with the service account ${clientEmail}.`
    );
  }

  if (status === 404 || apiStatus === "NOT_FOUND") {
    return new Error(
      `Google Sheets spreadsheet not found while ${action}. ` +
        `Check GOOGLE_SHEETS_SPREADSHEET_ID (${spreadsheetId}).`
    );
  }

  if (apiMessage) {
    return new Error(`Google Sheets error while ${action}: ${apiMessage}`);
  }

  return error instanceof Error
    ? error
    : new Error(`Google Sheets error while ${action}.`);
}

async function getHeaderIndex(
  context: SheetsContext,
  spreadsheetId: string,
  config: TradeLogConfig
): Promise<HeaderIndex> {
  const range = `${config.sheetName}!${config.headerRow}:${config.headerRow}`;
  let response;
  try {
    response = await context.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
  } catch (error) {
    throw formatSheetsError(
      error,
      spreadsheetId,
      context.clientEmail,
      "reading headers"
    );
  }
  const headers = response.data.values?.[0] ?? [];
  const index: HeaderIndex = {};

  headers.forEach((header: unknown, i: number) => {
    if (typeof header === "string" && header.trim()) {
      index[header.trim()] = i;
    }
  });

  return index;
}

function buildRow(
  trade: TradeInput,
  headerIndex: HeaderIndex,
  config: TradeLogConfig
): string[] {
  const normalizedType = normalizeTransactionType(trade.transactionType);
  if (!VALID_TRANSACTION_TYPES.has(normalizedType)) {
    throw new Error(
      `Invalid transaction type '${trade.transactionType}'. ` +
        `Use one of: ${Array.from(VALID_TRANSACTION_TYPES).join(", ")}.`
    );
  }
  const totalAmount =
    Number.isFinite(trade.totalAmount) && trade.totalAmount !== 0
      ? trade.totalAmount
      : trade.quantity * trade.amountPerUnit;
  const entries: Array<[string | undefined, string | number | null | undefined]> =
    [
      [config.columns.date, trade.date],
      [config.columns.transactionType, normalizedType],
      [config.columns.symbol, trade.symbol],
      [config.columns.quantity, trade.quantity],
      [config.columns.amountPerUnit, trade.amountPerUnit],
      [config.columns.totalAmount, totalAmount],
      [config.columns.tradingFees, trade.tradingFees],
      [config.columns.investmentAccount, DEFAULT_INVESTMENT_ACCOUNT],
    ];

  const indices = entries
    .map(([header]) => (header ? headerIndex[header] : undefined))
    .filter((value): value is number => typeof value === "number");

  if (!indices.length) {
    const configuredHeaders = entries
      .map(([header]) => (header ? header.trim() : ""))
      .filter(Boolean);
    const sheetHeaders = Object.keys(headerIndex);
    const missingHeaders = configuredHeaders.filter(
      (header) => !sheetHeaders.includes(header)
    );
    console.warn(
      "No matching headers found when building trade row.",
      JSON.stringify(
        {
          sheetName: config.sheetName,
          headerRow: config.headerRow,
          configuredHeaders,
          sheetHeaders,
          missingHeaders,
        },
        null,
        2
      )
    );
    throw new Error(
      "No matching headers found. Check trade-log.json column names."
    );
  }

  const maxIndex = Math.max(...indices);

  const row = new Array(maxIndex + 1).fill("");

  entries.forEach(([header, value]) => {
    if (!header) {
      return;
    }
    const idx = headerIndex[header];
    if (typeof idx === "number") {
      row[idx] = value === null || value === undefined ? "" : String(value);
    }
  });

  return row;
}

async function getSheetProperties(
  context: SheetsContext,
  spreadsheetId: string,
  sheetName: string
): Promise<{ sheetId: number; rowCount: number; columnCount: number }> {
  let response;
  try {
    response = await context.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
    });
  } catch (error) {
    throw formatSheetsError(
      error,
      spreadsheetId,
      context.clientEmail,
      "reading sheet metadata"
    );
  }

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

  const targetRows = Math.max(rowCount, minRows);
  const targetColumns = Math.max(columnCount, minColumns);

  if (targetRows === rowCount && targetColumns === columnCount) {
    return;
  }

  try {
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
  } catch (error) {
    throw formatSheetsError(
      error,
      spreadsheetId,
      context.clientEmail,
      "resizing the trade log sheet"
    );
  }
}

export async function appendTradeRow(
  trade: TradeInput,
  config: TradeLogConfig
): Promise<void> {
  const context = getSheetsContext();
  const spreadsheetId = requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const headerIndex = await getHeaderIndex(context, spreadsheetId, config);
  const row = buildRow(trade, headerIndex, config);
  const dataStartRow = config.dataStartRow ?? config.headerRow + 1;

  let rows: string[][] = [];
  try {
    const existing = await context.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${config.sheetName}!A${dataStartRow}:ZZ`,
    });
    rows = (existing.data.values ?? []) as string[][];
  } catch (error) {
    throw formatSheetsError(
      error,
      spreadsheetId,
      context.clientEmail,
      "reading trade rows"
    );
  }

  const firstEmptyIndex = rows.findIndex(
    (existingRow) => !existingRow?.some((cell) => String(cell ?? "").trim())
  );
  const targetRow =
    dataStartRow + (firstEmptyIndex === -1 ? rows.length : firstEmptyIndex);

  await ensureSheetCapacity(
    context,
    spreadsheetId,
    config.sheetName,
    targetRow,
    row.length
  );

  try {
    await context.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${config.sheetName}!A${targetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [row],
      },
    });
  } catch (error) {
    throw formatSheetsError(
      error,
      spreadsheetId,
      context.clientEmail,
      "appending a trade row"
    );
  }
}

export async function readTrades(
  config: TradeLogConfig
): Promise<Record<string, string>[]> {
  const context = getSheetsContext();
  const spreadsheetId = requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const headerIndex = await getHeaderIndex(context, spreadsheetId, config);
  const headers = Object.entries(headerIndex).sort((a, b) => a[1] - b[1]);
  const dataStartRow = config.dataStartRow ?? config.headerRow + 1;
  const range = `${config.sheetName}!A${dataStartRow}:ZZ`;
  let response;
  try {
    response = await context.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
  } catch (error) {
    throw formatSheetsError(
      error,
      spreadsheetId,
      context.clientEmail,
      "reading trade rows"
    );
  }
  const rows = response.data.values ?? [];

  return rows.map((row: Array<string | number | null | undefined>) => {
    const entry: Record<string, string> = {};
    headers.forEach(([header, idx]) => {
      entry[header] = row[idx] ? String(row[idx]) : "";
    });
    return entry;
  });
}
