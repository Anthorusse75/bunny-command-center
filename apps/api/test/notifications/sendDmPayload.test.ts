import { describe, expect, it } from "vitest";
import { buildSendDmPayloadJsonText } from "../../src/notifications/sendDmPayload.js";

const HUGE_SNOWFLAKE = "9223372036854775807"; // past Number.MAX_SAFE_INTEGER, real-shaped

describe("buildSendDmPayloadJsonText — matches the real Bunny validator's exact shape (02_NEW_BOT_OCR/functions/operator_command_consumer.py:1194-1240)", () => {
  it("produces a JSON object with discord_user_id as an UNQUOTED numeric literal (Python `int`, never a string) and the other 3 fields as JSON strings", () => {
    const text = buildSendDmPayloadJsonText({
      discordUserId: HUGE_SNOWFLAKE,
      content: "Upload completed: 3 screenshots",
      footer: "Manage your notification preferences → https://example.com/notifications/preferences",
      correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    // Parsed via plain JSON.parse for this assertion only — JS floating-point
    // approximation on this READ side is expected/irrelevant (Number(HUGE_SNOWFLAKE),
    // not a hardcoded literal, avoids an eslint no-loss-of-precision flag on a
    // literal this large): the load-bearing property under test is the RAW
    // TEXT this function produced (checked below), never this parse result —
    // the WRITE side never round-trips through JS Number at any point.
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({
      discord_user_id: Number(HUGE_SNOWFLAKE),
      content: "Upload completed: 3 screenshots",
      footer: "Manage your notification preferences → https://example.com/notifications/preferences",
      correlation_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    // The load-bearing assertion: the RAW TEXT contains the exact digit
    // sequence, unquoted — never `"9223372036854775807"` (a JSON string,
    // which Bunny's `isinstance(discord_user_id, int)` check would reject)
    // and never anything JS `Number()`/`JSON.parse` on our OWN side could
    // have silently rounded before this text was built.
    expect(text).toContain(`"discord_user_id":${HUGE_SNOWFLAKE}`);
    expect(text).not.toContain(`"discord_user_id":"${HUGE_SNOWFLAKE}"`);
  });

  it("never runs discordUserId through Number()/parseInt() — verified by exact-digit round-trip for a value that would lose precision if it had", () => {
    const text = buildSendDmPayloadJsonText({
      discordUserId: HUGE_SNOWFLAKE,
      content: "x",
      footer: "",
      correlationId: "id",
    });
    const match = /"discord_user_id":(\d+)/.exec(text);
    expect(match?.[1]).toBe(HUGE_SNOWFLAKE);
    // Sanity-check the premise: this value genuinely differs from its
    // nearest JS-safe-integer-rounded neighbor once run through Number().
    expect(String(Number(HUGE_SNOWFLAKE))).not.toBe(HUGE_SNOWFLAKE);
  });

  it("throws (never silently coerces) for a syntactically invalid discordUserId", () => {
    expect(() =>
      buildSendDmPayloadJsonText({
        discordUserId: "not-a-snowflake",
        content: "x",
        footer: "",
        correlationId: "id",
      }),
    ).toThrow();
  });

  it("throws for empty content (Bunny's own validator: :1207-1209, non-empty required)", () => {
    expect(() =>
      buildSendDmPayloadJsonText({
        discordUserId: HUGE_SNOWFLAKE,
        content: "",
        footer: "",
        correlationId: "id",
      }),
    ).toThrow();
  });

  it("safely escapes content/footer/correlation_id containing quotes and newlines", () => {
    const text = buildSendDmPayloadJsonText({
      discordUserId: HUGE_SNOWFLAKE,
      content: 'quote " and newline\n here',
      footer: "",
      correlationId: "id",
    });
    const parsed = JSON.parse(text) as { content: string };
    expect(parsed.content).toBe('quote " and newline\n here');
  });
});
