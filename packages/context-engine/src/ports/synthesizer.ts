import type { EvidencePack, QueryContextRequest, SynthesisOutput } from "../domain/query.js";

export interface ContextSynthesizer {
  synthesize(input: {
    request: QueryContextRequest;
    evidence: EvidencePack;
    conflicts: string[];
    repairErrors?: string[];
  }): Promise<SynthesisOutput>;
}

export interface ScopeAuthorization {
  allowed: boolean;
  allowedAclFingerprints: ReadonlySet<string>;
  reason?: string;
}

export interface ScopeAuthorizer {
  authorize(input: {
    tenantId: string;
    principalId: string;
    repository: string;
    ref: string;
  }): Promise<ScopeAuthorization>;
}
