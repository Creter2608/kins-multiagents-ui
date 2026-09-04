/**
 * scripts/harness/network-policy.d.mts
 * Type declarations for Hermetic Network Egress Policy & Proxy Enforcement.
 */

import type { NetworkPolicy } from "../../src/shared/harness.js";

export interface NetworkPolicyValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateNetworkPolicy(policy: unknown): NetworkPolicyValidationResult;
export function normalizeAllowedHost(host: string): string;
export function isDestinationAllowed(destination: string, policy: NetworkPolicy): boolean;
export function buildProxyEnvironment(policy: NetworkPolicy): Record<string, string>;
