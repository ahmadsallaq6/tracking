import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TradeLogConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadTradeLogConfig(): TradeLogConfig {
  const configPath = path.resolve(__dirname, "..", "config", "trade-log.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as TradeLogConfig;
}
