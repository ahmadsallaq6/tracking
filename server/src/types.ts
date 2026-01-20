export interface TradeInput {
  symbol: string;
  transactionType: "buy" | "sell";
  quantity: number;
  amountPerUnit: number;
  totalAmount: number;
  tradingFees: number;
  investmentAccount: string;
  date: string;
}

export interface SummaryQuery {
  symbol?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface TradeLogConfig {
  sheetName: string;
  headerRow: number;
  dataStartRow?: number;
  columns: {
    date: string;
    transactionType: string;
    symbol: string;
    quantity: string;
    amountPerUnit: string;
    totalAmount: string;
    tradingFees: string;
    investmentAccount: string;
  };
}
