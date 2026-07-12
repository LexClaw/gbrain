import { createPublicKey, verify as edVerify } from 'crypto';
import {
  allowlistEnvelopeSigningBytes,
  type Allowlist,
  type AllowlistEnvelope,
  type TrustedApprovalKey,
} from '../../src/recovery/content-recovery.ts';

export function verifyRehearsalAllowlistEnvelope(envelope: AllowlistEnvelope, trustedRoots: readonly TrustedApprovalKey[], now = Date.now()): Allowlist {
  if (envelope.schema_version !== 'recovery_allowlist_envelope_v1') throw new Error('unsupported allowlist envelope schema_version');
  const trusted = trustedRoots.filter(root => root.key_id === envelope.key_id);
  if (trusted.length !== 1) throw new Error(`allowlist envelope key_id is not trusted: ${envelope.key_id}`);
  if (trusted[0].signer !== envelope.signer) throw new Error('allowlist envelope signer does not match key_id');
  const approvedAt = Date.parse(envelope.approved_at);
  const expiresAt = Date.parse(envelope.expires_at);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) throw new Error('allowlist envelope timestamps are malformed');
  if (approvedAt > now + 5 * 60_000) throw new Error('allowlist envelope artifact is future-dated');
  if (expiresAt <= now) throw new Error('allowlist envelope artifact is expired');
  if (expiresAt - approvedAt > 7 * 24 * 60 * 60_000) throw new Error('allowlist envelope expiry exceeds seven days');
  if (!trusted[0].public_key_pem) throw new Error('allowlist envelope reviewed root missing public key material');
  const publicKey = createPublicKey(trusted[0].public_key_pem);
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64) throw new Error('allowlist envelope signature has invalid Ed25519 length');
  if (!edVerify(null, allowlistEnvelopeSigningBytes(envelope), publicKey, signature)) throw new Error('allowlist envelope signature verification failed');
  return envelope.allowlist;
}
