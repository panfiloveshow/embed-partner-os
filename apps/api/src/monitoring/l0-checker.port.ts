import type { L0CheckObservation } from "./l0-embed-checker.js";

export const L0_CHECKER = Symbol("L0_CHECKER");

export interface L0Checker {
  check(pageUrl: string): Promise<L0CheckObservation>;
}
