/**
 * V2 Sol decision packet and fixture client.
 */

import type {
  SolV2Action,
  V2DecisionPacket,
  V2SolDecision,
} from "./types.js";
import { nowIso } from "../util/io.js";

export interface V2SolClient {
  decide(packet: V2DecisionPacket): Promise<V2SolDecision>;
}

export function buildDecisionPacket(
  packet: Omit<V2DecisionPacket, "hardRuleStatus"> & {
    hardRuleFailures?: string[];
  },
): V2DecisionPacket {
  const failures = packet.hardRuleFailures ?? [];
  return {
    ...packet,
    hardRuleStatus: {
      allHardRulesPass: failures.length === 0,
      failures,
    },
  };
}

/**
 * Scripted Sol client for tests — no live API calls.
 */
export function createFixtureSolClient(
  script: SolV2Action[],
): V2SolClient & { callCount: number } {
  let index = 0;
  let callCount = 0;

  return {
    get callCount() {
      return callCount;
    },
    async decide(_packet: V2DecisionPacket): Promise<V2SolDecision> {
      callCount += 1;
      if (index >= script.length) {
        throw new Error(
          `Fixture Sol client exhausted at call #${callCount}`,
        );
      }
      const action = script[index]!;
      index += 1;
      return {
        action,
        rationale: `fixture Sol chose ${action}`,
        decidedAt: nowIso(),
      };
    },
  };
}

/**
 * Sol client that always returns a fixed action.
 */
export function createStaticSolClient(action: SolV2Action): V2SolClient {
  return {
    async decide(): Promise<V2SolDecision> {
      return {
        action,
        rationale: `static Sol: ${action}`,
        decidedAt: nowIso(),
      };
    },
  };
}
