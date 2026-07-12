import {
  verifyDisposableRehearsalAllowlistEnvelope,
  type Allowlist,
  type AllowlistEnvelope,
  type TrustedApprovalKey,
} from '../../src/recovery/content-recovery.ts';

export function verifyRehearsalAllowlistEnvelope(envelope: AllowlistEnvelope, trustedRoots: readonly TrustedApprovalKey[], now = Date.now()): Allowlist {
  return verifyDisposableRehearsalAllowlistEnvelope(envelope, trustedRoots, now);
}
