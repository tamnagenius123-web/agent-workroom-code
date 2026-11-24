// Compatibility imports for decision consumers. Transport, token parsing and
// micro-USD arithmetic are implemented once by the reservation-aware client.
export {
  BUNDLED_ROSTER_PATH as ROSTER_PATH,
  OPENROUTER_CHAT_URL as CHAT_URL, OPENROUTER_GENERATION_URL as GENERATION_URL,
  loadRoster, estimateMicroUsd, reservationMicroUsd, roundUsdToMicro,
  getGenerationCost, sendReservedChat, OpenRouterError,
} from '../or-harness/client.ts';
export type { RosterModel, Roster, ChatUsage, GenerationTokens, GenerationCost, FetchLike } from '../or-harness/client.ts';
