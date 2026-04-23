import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildCompactionFidelitySummaryPrefix } from "./compact.js";

describe("compaction fidelity guardrail", () => {
  it("adds a one-line pointer for each parallel tool-call category", () => {
    const messages = [
      { role: "user", content: "ship the gateway patch and tell Nathan" },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "1", name: "gateway", input: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "2", name: "exec", input: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "3", name: "message", input: {} }],
      },
    ] as unknown as AgentMessage[];

    const prefix = buildCompactionFidelitySummaryPrefix(messages) ?? "";

    expect(prefix).toContain("Your earlier session touched: [chat, gateway, exec, message]");
    expect(prefix).toContain("- gateway:");
    expect(prefix).toContain("- exec:");
    expect(prefix).toContain("- message:");
  });
});
