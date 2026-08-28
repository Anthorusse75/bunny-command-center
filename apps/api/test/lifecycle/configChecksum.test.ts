/**
 * Section 5 (Step 10 external-review correction round) — cross-language
 * golden compatibility test. `computeMaterializedConfigChecksum`/
 * `canonicalPyJson` MUST byte-for-byte match
 * `01_NEW_SELF_BOTS/src/database/repositories/guild_config.py`'s
 * `_checksum()` for the exact same payload. The 3 expected hex digests
 * below were generated ONCE by actually running that real Python function
 * (a verbatim, stdlib-only copy — `hashlib`/`json` only, no repo import —
 * see this step's report for the exact generation script) against the
 * exact payloads reproduced here — never hand-computed or guessed.
 * `01_NEW_SELF_BOTS` itself was never modified to produce these.
 *
 * Payload 1: a guild's very first version, all-default values, small ids.
 * Payload 2: real 64-bit-scale snowflakes (> 2^53-1, up to the real
 *   BIGINT UNSIGNED max 2^64-1) plus every orchestrator override and a
 *   nested `decision_rules_json` object — proves the BigInt-precision fix
 *   actually matters (a `JSON.stringify`-based port would silently produce
 *   a DIFFERENT hash for `herowarbotChannelId: "18446744073709551615"`,
 *   since that value exceeds `Number.MAX_SAFE_INTEGER` by roughly 2000x).
 * Payload 3: a SPARSE orchestrator dict (matching guild_config.py's own
 *   unit test shape, `{max_guild_inflight: 1}` only) built directly from
 *   this module's low-level `pyDict`/`pyInt`/... primitives (bypassing the
 *   "always full column" `MaterializedConfigValues` convenience wrapper) —
 *   proves the underlying serializer is byte-for-byte correct for ANY dict
 *   shape, full or sparse; the "always full" choice is a materialization-time
 *   policy this module adopts, not a serializer limitation (see
 *   configChecksum.ts's header comment).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalPyJson,
  computeMaterializedConfigChecksum,
  pyBool,
  pyDecimal,
  pyDict,
  pyInt,
  pyList,
  pyNull,
  pyStr,
  type MaterializedConfigValues,
} from "../../src/lifecycle/configChecksum.js";

const PAYLOAD_1_EXPECTED_HEX = "aa046c2b32b0d3c1d827320266bbd18ce7a4b2a0d04ec6d137a79a2a37f05bf4";
const PAYLOAD_2_EXPECTED_HEX = "7c9f4044e117c2459cc9211c1b857559965b5e70a10ea45cc0f0ab55f0ddef0d";
const PAYLOAD_3_EXPECTED_HEX = "e0400fdd751f676056f31059419a938f67bfd9a1224fd9ba129420955ebda91d";

const payload1: MaterializedConfigValues = {
  common: { timezone: "Europe/Paris", operationalEnabled: true, locale: "en", guildWeight: "1.000" },
  bunny: {
    incomingChannelId: "500000000000000001",
    processedChannelId: null,
    ingestionEnabled: true,
    sourceDeletePolicy: "KEEP",
    saveProcessedCopy: false,
    ocrEngine: "TESSERACT",
    ocrProfile: "DEFAULT",
    perGuildConcurrency: 1,
    maxOcrAttempts: 3,
    retryBaseSeconds: 30,
    catchupIntervalSeconds: 300,
    maxAttachmentBytes: "10485760",
    allowedMime: ["image/png", "image/jpeg", "image/webp"],
  },
  selfbot: {
    herowarbotChannelId: "500000000000000002",
    screenshotsChannelId: null,
    communityChannelId: null,
    automationEnabled: false,
    profileEnabled: false,
    profileTimeoutSeconds: 60,
    profileStaleSeconds: 3600,
    heroResponseTimeoutSeconds: 180,
    maxDeliveryAttempts: 3,
    communityUpdatesEnabled: true,
    everyoneMentionsEnabled: true,
    reminderEnabled: true,
    nbGcHero: 912,
    nbGcTitan: 380,
    nbHol: 600,
    nbHero: 1200,
    nbTitan: 600,
    autoProfileIntervalSeconds: 1800,
    autoMaxPerCycle: 10,
  },
  orchestrator: {
    maxGuildInflight: null,
    maxChannelInflight: null,
    riskEvalMinSeconds: null,
    riskEvalMaxSeconds: null,
    sendMinSeconds: null,
    sendMaxSeconds: null,
    profileMinSeconds: null,
    profileMaxSeconds: null,
    reminderMinSeconds: null,
    reminderMaxSeconds: null,
    criticalHoursRemaining: null,
    heroLatencyCircuitSeconds: null,
    errorRateCircuit: null,
    minSampleSize: null,
    fairnessWeight: null,
    starvationSeconds: null,
    decisionRulesJson: null,
  },
};

const payload2: MaterializedConfigValues = {
  common: { timezone: "America/New_York", operationalEnabled: false, locale: "fr-FR", guildWeight: "2.500" },
  bunny: {
    incomingChannelId: "987654321098765432",
    processedChannelId: "987654321098765999",
    ingestionEnabled: false,
    sourceDeletePolicy: "DELETE",
    saveProcessedCopy: true,
    ocrEngine: "TESSERACT",
    ocrProfile: "HIGH_ACCURACY",
    perGuildConcurrency: 4,
    maxOcrAttempts: 5,
    retryBaseSeconds: 15,
    catchupIntervalSeconds: 120,
    maxAttachmentBytes: "20971520",
    allowedMime: ["image/png"],
  },
  selfbot: {
    // BIGINT UNSIGNED max (2^64-1) — far beyond Number.MAX_SAFE_INTEGER.
    herowarbotChannelId: "18446744073709551615",
    screenshotsChannelId: "111111111111111111",
    communityChannelId: "222222222222222222",
    automationEnabled: true,
    profileEnabled: true,
    profileTimeoutSeconds: 60,
    profileStaleSeconds: 7200,
    heroResponseTimeoutSeconds: 180,
    maxDeliveryAttempts: 3,
    communityUpdatesEnabled: true,
    everyoneMentionsEnabled: true,
    reminderEnabled: false,
    nbGcHero: 1000,
    nbGcTitan: 400,
    nbHol: 650,
    nbHero: 1300,
    nbTitan: 650,
    autoProfileIntervalSeconds: 900,
    autoMaxPerCycle: 20,
  },
  orchestrator: {
    maxGuildInflight: 3,
    maxChannelInflight: 1,
    riskEvalMinSeconds: 5,
    riskEvalMaxSeconds: 30,
    sendMinSeconds: 2,
    sendMaxSeconds: 10,
    profileMinSeconds: 1,
    profileMaxSeconds: 5,
    reminderMinSeconds: 60,
    reminderMaxSeconds: 300,
    criticalHoursRemaining: 12,
    heroLatencyCircuitSeconds: 45,
    errorRateCircuit: "0.05000",
    minSampleSize: 20,
    fairnessWeight: "1.500",
    starvationSeconds: 600,
    decisionRulesJson: { mode: "strict", thresholds: [1, 2, 3] },
  },
};

describe("configChecksum — cross-language golden compatibility (Section 5)", () => {
  it("payload 1 (bootstrap defaults, small ids) matches the real Python _checksum() digest", () => {
    const checksum = computeMaterializedConfigChecksum(payload1);
    expect(checksum.toString("hex")).toBe(PAYLOAD_1_EXPECTED_HEX);
  });

  it("payload 2 (real 64-bit-scale snowflakes, full orchestrator overrides, nested decision_rules_json) matches the real Python _checksum() digest — proves the BigInt-precision fix matters", () => {
    const checksum = computeMaterializedConfigChecksum(payload2);
    expect(checksum.toString("hex")).toBe(PAYLOAD_2_EXPECTED_HEX);
  });

  it("a JS-number round-trip of the payload-2 snowflake WOULD silently corrupt it — demonstrates why every column here is typed/handled as an exact digit string, never routed through Number()", () => {
    const corrupted = Number("18446744073709551615");
    expect(corrupted.toString()).not.toBe("18446744073709551615");
    expect(BigInt("18446744073709551615").toString()).toBe("18446744073709551615");
  });

  it("payload 3 (sparse orchestrator dict, matching guild_config.py's own unit test shape) — the low-level serializer matches the real Python _checksum() digest for a partial dict too", () => {
    const payload3 = pyDict({
      common: pyDict({
        timezone: pyStr("Europe/Paris"),
        operational_enabled: pyBool(true),
        locale: pyStr("en"),
        guild_weight: pyDecimal("1.000"),
      }),
      bunny: pyDict({
        incoming_channel_id: pyInt(1),
        processed_channel_id: pyNull,
        ingestion_enabled: pyBool(true),
        source_delete_policy: pyStr("KEEP"),
        save_processed_copy: pyBool(false),
        ocr_engine: pyStr("TESSERACT"),
        ocr_profile: pyStr("DEFAULT"),
        per_guild_concurrency: pyInt(1),
        max_ocr_attempts: pyInt(3),
        retry_base_seconds: pyInt(30),
        catchup_interval_seconds: pyInt(300),
        max_attachment_bytes: pyInt(10485760),
        allowed_mime_json: pyList([pyStr("image/png"), pyStr("image/jpeg"), pyStr("image/webp")]),
      }),
      selfbot: pyDict({
        herowarbot_channel_id: pyInt(2),
        screenshots_channel_id: pyNull,
        community_channel_id: pyNull,
        automation_enabled: pyBool(false),
        profile_enabled: pyBool(false),
        profile_timeout_seconds: pyInt(60),
        profile_stale_seconds: pyInt(3600),
        hero_response_timeout_seconds: pyInt(180),
        max_delivery_attempts: pyInt(3),
        community_updates_enabled: pyBool(true),
        everyone_mentions_enabled: pyBool(true),
        reminder_enabled: pyBool(true),
        nb_gc_hero: pyInt(912),
        nb_gc_titan: pyInt(380),
        nb_hol: pyInt(600),
        nb_hero: pyInt(1200),
        nb_titan: pyInt(600),
        auto_profile_interval_seconds: pyInt(1800),
        auto_max_per_cycle: pyInt(10),
      }),
      // Sparse on purpose — only the one key a real caller passed.
      orchestrator: pyDict({ max_guild_inflight: pyInt(1) }),
    });
    const digest = createHash("sha256").update(canonicalPyJson(payload3), "utf8").digest("hex");
    expect(digest).toBe(PAYLOAD_3_EXPECTED_HEX);
  });
});
