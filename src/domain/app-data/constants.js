/** Version and size constants shared by every AppData runtime. */
export const APP_DATA_DB_SCHEMA_VERSION = 2;
export const APP_DATA_EXCHANGE_SCHEMA_VERSION = 2;
export const APP_DATA_PROTOCOL_VERSION = 2;
export const APP_DATA_PAYLOAD_SCHEMA_VERSION = 1;
export const CANONICAL_FORMAT = "qb-canonical-v1";

export const APP_DATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxObjectKeys: 1_000,
  maxArrayItems: 5_000,
  maxStringUtf8Bytes: 1_048_576,
  maxCanonicalUtf8Bytes: 3 * 1024 * 1024,
  maxMutationUtf8Bytes: 16 * 1024,
  maxPushMutations: 100,
  maxPushUtf8Bytes: 256 * 1024,
  maxPushResponseUtf8Bytes: 64 * 1024,
  maxPullChanges: 200,
  maxPullUtf8Bytes: 512 * 1024,
  maxContentChunkBytes: 512 * 1024,
  maxPrivateBankUtf8Bytes: 3 * 1024 * 1024,
  maxPrivateBankQuestions: 5_000,
  maxPrivateBanks: 15
});

/**
 * The large-content codec is still qb-canonical-v1.  These are fixed product
 * limits, not a caller supplied validator option.  They are deliberately
 * separate from the small DTO limits above so a public bank containing media
 * is not rejected by the ordinary 3 MiB transport guard.
 */
export const APP_DATA_CONTENT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxObjectKeys: 1_000,
  maxArrayItems: 100_000,
  maxStringUtf8Bytes: 100 * 1024 * 1024,
  maxCanonicalUtf8Bytes: 100 * 1024 * 1024
});
export const CANONICAL_CONTENT_LIMITS = APP_DATA_CONTENT_LIMITS;

export const ALIAS_KEY_PATH = Object.freeze(["sourceKey", "legacyRevision", "legacyId"]);
