import { describe, expect, it } from "vitest";
import {
  mapOperatorCommandStateToDeliveryState,
  SEND_DM_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
} from "../../src/notifications/deliveryStateMapping.js";

describe("mapOperatorCommandStateToDeliveryState — correction #2's exact contract", () => {
  it("SUCCEEDED -> SENT", () => {
    expect(mapOperatorCommandStateToDeliveryState({ state: "SUCCEEDED", lastErrorCode: null })).toBe("SENT");
  });

  it.each(["FAILED", "EXPIRED", "CANCELLED"])("%s -> FAILED", (state) => {
    expect(mapOperatorCommandStateToDeliveryState({ state, lastErrorCode: null })).toBe("FAILED");
  });

  it.each(["QUEUED", "CLAIMED", "RUNNING", "RETRY_WAIT"])("%s stays PENDING", (state) => {
    expect(mapOperatorCommandStateToDeliveryState({ state, lastErrorCode: null })).toBe("PENDING");
  });

  it("an unrecognized state string stays PENDING rather than throwing", () => {
    expect(mapOperatorCommandStateToDeliveryState({ state: "SOME_FUTURE_STATE", lastErrorCode: null })).toBe(
      "PENDING",
    );
  });

  it(`FAILED with last_error_code=${SEND_DM_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE} maps to FAILED (never re-enqueued by this function's caller)`, () => {
    expect(
      mapOperatorCommandStateToDeliveryState({
        state: "FAILED",
        lastErrorCode: SEND_DM_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
      }),
    ).toBe("FAILED");
  });

  it("the exact error code constant matches the real Bunny source (02_NEW_BOT_OCR/functions/operator_command_consumer.py:910-911)", () => {
    expect(SEND_DM_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE).toBe("SEND_DM_DELIVERY_OUTCOME_UNKNOWN");
  });
});
