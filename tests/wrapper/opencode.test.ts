import { describe, it, expect } from "vitest";
import { parseOpenCodeRows } from "../../src/wrapper/opencode.js";

describe("parseOpenCodeRows", () => {
  it("extracts user/assistant text and completed write tool events", () => {
    const rows = [
      {
        message_id: "msg-user",
        message_data: JSON.stringify({ role: "user" }),
        part_id: "prt-user-text",
        part_data: JSON.stringify({
          type: "text",
          text: "\"Create a file named demo.txt\"\n",
        }),
        time_created: 1000,
      },
      {
        message_id: "msg-assistant",
        message_data: JSON.stringify({ role: "assistant" }),
        part_id: "prt-tool",
        part_data: JSON.stringify({
          type: "tool",
          tool: "write",
          state: {
            status: "completed",
            input: {
              filePath: "/tmp/demo.txt",
              content: "hello",
            },
            output: "Wrote file successfully.",
            metadata: {
              filepath: "/tmp/demo.txt",
            },
          },
        }),
        time_created: 1100,
      },
      {
        message_id: "msg-assistant",
        message_data: JSON.stringify({ role: "assistant" }),
        part_id: "prt-assistant-text",
        part_data: JSON.stringify({
          type: "text",
          text: "\n\nCreated the file.",
        }),
        time_created: 1200,
      },
    ];

    const parsed = parseOpenCodeRows(rows, "ses-opencode-test");

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({
      role: "user",
      content: "Create a file named demo.txt",
      index: 0,
    });
    expect(parsed.messages[1]).toMatchObject({
      role: "assistant",
      content: "Created the file.",
      index: 1,
    });

    expect(parsed.events).toEqual([
      {
        tool: "write",
        args: {
          filePath: "/tmp/demo.txt",
          content: "hello",
        },
        result: {
          output: "Wrote file successfully.",
          success: true,
          filepath: "/tmp/demo.txt",
        },
        success: true,
      },
    ]);
  });
});
