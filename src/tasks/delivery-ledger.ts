export type DeliveryLedgerTurnTiming = "same_turn" | "later_turn" | "unknown";

export type DeliveryLedgerEntry = {
  kind: "task_state_change";
  channel: "direct_message" | "system_queue";
  recordedAt: number;
  eventAt: number;
  eventKind: string;
  turnTiming: DeliveryLedgerTurnTiming;
  idempotencyKey?: string;
};

export type DeliveryLedger = {
  entries: DeliveryLedgerEntry[];
};

const DELIVERY_LEDGER_ENTRY_CAP = 20;

export function appendDeliveryLedgerEntry(
  ledger: DeliveryLedger | undefined,
  entry: DeliveryLedgerEntry,
): DeliveryLedger {
  const nextEntries = [...(ledger?.entries ?? []), entry];
  return {
    entries: nextEntries.slice(-DELIVERY_LEDGER_ENTRY_CAP),
  };
}

export function resolveBasicDeliveryTurnTiming(
  ledger: DeliveryLedger | undefined,
): DeliveryLedgerTurnTiming {
  return (ledger?.entries.length ?? 0) > 0 ? "later_turn" : "same_turn";
}
