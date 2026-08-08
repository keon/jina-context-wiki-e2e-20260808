import {
  fingerprint,
  normalizeRepository,
  validateWikiAuditReportArtifactRef,
  type WikiAuditReportArtifactRef
} from "@jina/context-engine";
import type { QueryResultRow } from "pg";
import { ContextDatabase, dateString } from "./database.js";

export type WikiAuditOutcome = "passed" | "needs_improvement" | "error";
export type WikiAuditFollowupOutcome = "admitted" | "already_admitted" | "superseded" | "policy_denied";

export interface WikiReleaseAuditRecord {
  readonly auditId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly releaseId: string;
  readonly locale: string;
  readonly publicSnapshotDigest: string;
  readonly auditPolicyVersion: string;
  readonly auditorConfigDigest: string;
  readonly auditWindow: string;
  readonly auditInputDigest: string;
  readonly triggerRunId: string;
  readonly outcome: WikiAuditOutcome;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly reportArtifact: WikiAuditReportArtifactRef;
  readonly completedAt: string;
}

export interface WikiAuditFollowupRecord {
  readonly auditId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly requestKey: string;
  readonly boardBuildId?: string;
  readonly currentReleaseIdAtDecision?: string;
  readonly admittedAt?: string;
  readonly admissionOutcome: WikiAuditFollowupOutcome;
  readonly decidedAt: string;
}

export interface DueWikiAudit {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly locale: string;
  readonly releaseId: string;
  readonly commitSha: string;
  readonly publicSnapshotDigest: string;
}

export interface WikiAuditRunClaim {
  readonly auditId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly releaseId: string;
  readonly locale: string;
  readonly publicSnapshotDigest: string;
  readonly auditPolicyVersion: string;
  readonly auditorConfigDigest: string;
  readonly auditWindow: string;
  readonly auditInputDigest: string;
  readonly triggerRunId: string;
  readonly claimedAt: string;
}

interface AuditRow extends QueryResultRow {
  audit_id: string;
  tenant_id: string;
  repository: string;
  release_id: string;
  locale: string;
  public_snapshot_digest: string;
  audit_policy_version: string;
  auditor_config_digest: string;
  audit_window: string;
  audit_input_digest: string;
  trigger_run_id: string;
  outcome: WikiAuditOutcome;
  summary: unknown;
  report_artifact: unknown;
  completed_at: Date | string;
}

interface FollowupRow extends QueryResultRow {
  audit_id: string;
  tenant_id: string;
  repository: string;
  request_key: string;
  board_build_id: string | null;
  current_release_id_at_decision: string | null;
  admitted_at: Date | string | null;
  admission_outcome: WikiAuditFollowupOutcome;
  decided_at: Date | string;
}

interface AuditRunRow extends QueryResultRow {
  audit_id: string;
  tenant_id: string;
  repository: string;
  release_id: string;
  locale: string;
  public_snapshot_digest: string;
  audit_policy_version: string;
  auditor_config_digest: string;
  audit_window: string;
  audit_input_digest: string;
  trigger_run_id: string;
  claimed_at: Date | string;
}

const AUDIT_COLUMNS = `audit_id,tenant_id,repository,release_id,locale,public_snapshot_digest,
  audit_policy_version,auditor_config_digest,audit_window,audit_input_digest,trigger_run_id,
  outcome,summary,report_artifact,completed_at`;
const FOLLOWUP_COLUMNS = `audit_id,tenant_id,repository,request_key,board_build_id,
  current_release_id_at_decision,admitted_at,admission_outcome,decided_at`;
const AUDIT_RUN_COLUMNS = `audit_id,tenant_id,repository,release_id,locale,public_snapshot_digest,
  audit_policy_version,auditor_config_digest,audit_window,audit_input_digest,trigger_run_id,claimed_at`;
const QUALIFIED_AUDIT_RUN_COLUMNS = `run.audit_id,run.tenant_id,run.repository,run.release_id,run.locale,
  run.public_snapshot_digest,run.audit_policy_version,run.auditor_config_digest,run.audit_window,
  run.audit_input_digest,run.trigger_run_id,run.claimed_at`;

export class PostgresWikiAuditRepository {
  constructor(private readonly database: ContextDatabase) {}

  async claimRun(input: WikiAuditRunClaim): Promise<{ readonly record: WikiAuditRunClaim; readonly created: boolean }> {
    const normalized = normalizeRunClaim(input);
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [normalized.tenantId] },
      async (client) => {
        const inserted = await client.query<AuditRunRow>(
          `insert into jina_context.context_release_audit_runs (${AUDIT_RUN_COLUMNS})
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)
           on conflict do nothing returning ${AUDIT_RUN_COLUMNS}`,
          auditRunValues(normalized)
        );
        if (inserted.rows[0]) return { record: auditRunFromRow(inserted.rows[0]), created: true };
        const existing = await client.query<AuditRunRow>(
          `select ${AUDIT_RUN_COLUMNS} from jina_context.context_release_audit_runs
           where audit_id=$1 or audit_input_digest=$2 or trigger_run_id=$3 for share`,
          [normalized.auditId, normalized.auditInputDigest, normalized.triggerRunId]
        );
        const record = existing.rows[0] ? auditRunFromRow(existing.rows[0]) : undefined;
        if (!record || fingerprint(runClaimIdentity(record)) !== fingerprint(runClaimIdentity(normalized))) {
          throw new Error("wiki audit run identity is already claimed by another Trigger execution");
        }
        return { record, created: false };
      },
      "wiki_audit_claim_run"
    );
  }

  async getRunClaim(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
  }): Promise<WikiAuditRunClaim | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const auditId = requiredText(input.auditId, "auditId", 240);
    const result = await this.database.queryAs<AuditRunRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${AUDIT_RUN_COLUMNS} from jina_context.context_release_audit_runs
       where tenant_id=$1 and repository=$2 and audit_id=$3`,
      [tenantId, repository, auditId],
      "wiki_audit_run_get"
    );
    return result.rows[0] ? auditRunFromRow(result.rows[0]) : undefined;
  }

  async listUnsettledRuns(input: {
    readonly tenantId: string;
    readonly afterAuditId?: string;
    readonly limit?: number;
  }): Promise<readonly WikiAuditRunClaim[]> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const after = input.afterAuditId ? requiredText(input.afterAuditId, "afterAuditId", 240) : undefined;
    const limit = Math.min(100, Math.max(1, input.limit ?? 100));
    const result = await this.database.queryAs<AuditRunRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${AUDIT_RUN_COLUMNS} from jina_context.context_release_audit_runs run
       where run.tenant_id=$1 and ($2::text is null or run.audit_id>$2)
         and not exists (
           select 1 from jina_context.context_release_audits terminal
           where terminal.tenant_id=run.tenant_id and terminal.repository=run.repository
             and terminal.audit_id=run.audit_id
         )
       order by run.audit_id limit $3`,
      [tenantId, after ?? null, limit],
      "wiki_audit_runs_unsettled"
    );
    return result.rows.map(auditRunFromRow);
  }

  async listPendingImprovementRuns(input: {
    readonly tenantId: string;
    readonly afterAuditId?: string;
    readonly limit?: number;
  }): Promise<readonly WikiAuditRunClaim[]> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const after = input.afterAuditId ? requiredText(input.afterAuditId, "afterAuditId", 240) : undefined;
    const limit = Math.min(100, Math.max(1, input.limit ?? 100));
    const result = await this.database.queryAs<AuditRunRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${QUALIFIED_AUDIT_RUN_COLUMNS}
       from jina_context.context_release_audit_runs run
       join jina_context.context_release_audits terminal
         on terminal.tenant_id=run.tenant_id and terminal.repository=run.repository
        and terminal.audit_id=run.audit_id
       where run.tenant_id=$1 and terminal.outcome='needs_improvement'
         and ($2::text is null or run.audit_id>$2)
         and not exists (
           select 1 from jina_context.context_release_audit_followups followup
           where followup.tenant_id=run.tenant_id and followup.repository=run.repository
             and followup.audit_id=run.audit_id
         )
       order by run.audit_id limit $3`,
      [tenantId, after ?? null, limit],
      "wiki_audit_improvements_pending"
    );
    return result.rows.map(auditRunFromRow);
  }

  async get(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
  }): Promise<WikiReleaseAuditRecord | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const auditId = requiredText(input.auditId, "auditId", 240);
    const result = await this.database.queryAs<AuditRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${AUDIT_COLUMNS} from jina_context.context_release_audits
       where tenant_id=$1 and repository=$2 and audit_id=$3`,
      [tenantId, repository, auditId],
      "wiki_audit_get"
    );
    return result.rows[0] ? auditFromRow(result.rows[0]) : undefined;
  }

  async getFollowup(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
  }): Promise<WikiAuditFollowupRecord | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const auditId = requiredText(input.auditId, "auditId", 240);
    const result = await this.database.queryAs<FollowupRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${FOLLOWUP_COLUMNS} from jina_context.context_release_audit_followups
       where tenant_id=$1 and repository=$2 and audit_id=$3`,
      [tenantId, repository, auditId],
      "wiki_audit_followup_get"
    );
    return result.rows[0] ? followupFromRow(result.rows[0]) : undefined;
  }

  async insertTerminal(
    input: WikiReleaseAuditRecord
  ): Promise<{ readonly record: WikiReleaseAuditRecord; readonly created: boolean }> {
    const normalized = normalizeAudit(input);
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [normalized.tenantId] },
      async (client) => {
        const inserted = await client.query<AuditRow>(
          `insert into jina_context.context_release_audits (${AUDIT_COLUMNS})
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::timestamptz)
           on conflict do nothing
           returning ${AUDIT_COLUMNS}`,
          auditValues(normalized)
        );
        if (inserted.rows[0]) return { record: auditFromRow(inserted.rows[0]), created: true };
        const existing = await client.query<AuditRow>(
          `select ${AUDIT_COLUMNS} from jina_context.context_release_audits
           where audit_input_digest=$1 or audit_id=$2 for share`,
          [normalized.auditInputDigest, normalized.auditId]
        );
        const record = existing.rows[0] ? auditFromRow(existing.rows[0]) : undefined;
        if (!record || fingerprint(record) !== fingerprint(normalized)) {
          throw new Error("wiki audit input digest is already bound to a different immutable result");
        }
        return { record, created: false };
      },
      "wiki_audit_insert_terminal"
    );
  }

  async listDue(input: {
    readonly tenantId: string;
    readonly auditPolicyVersion: string;
    readonly auditorConfigDigest: string;
    readonly auditWindow: string;
    readonly after?: {
      readonly repository: string;
      readonly locale: string;
      readonly ref: string;
      readonly releaseId: string;
    };
    readonly limit?: number;
  }): Promise<readonly DueWikiAudit[]> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const policy = requiredText(input.auditPolicyVersion, "auditPolicyVersion", 240);
    const config = digest(input.auditorConfigDigest, "auditorConfigDigest");
    const window = requiredText(input.auditWindow, "auditWindow", 240);
    const limit = Math.min(100, Math.max(1, input.limit ?? 100));
    const after = input.after;
    const result = await this.database.queryAs<{
      tenant_id: string;
      repository: string;
      ref_name: string;
      locale: string;
      release_id: string;
      commit_sha: string;
      public_snapshot_digest: string;
    }>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select current.tenant_id,current.repository,current.ref_name,current.locale,
              current.release_id,current.commit_sha,current.public_snapshot_digest
       from jina_context.current_context_board_releases current
       where current.tenant_id=$1
         and ($5::text is null or (current.repository,current.locale,current.ref_name,current.release_id) > ($5,$6,$7,$8))
         and not exists (
           select 1 from jina_context.context_release_audits audit
           where audit.tenant_id=current.tenant_id
             and audit.repository=current.repository
             and audit.release_id=current.release_id
             and audit.locale=current.locale
             and audit.audit_policy_version=$2
             and audit.auditor_config_digest=$3
             and audit.audit_window=$4
         )
       order by current.repository,current.locale,current.ref_name,current.release_id
       limit $9`,
      [
        tenantId,
        policy,
        config,
        window,
        after ? normalizeRepository(after.repository) : null,
        after?.locale ?? null,
        after?.ref ?? null,
        after?.releaseId ?? null,
        limit
      ],
      "wiki_audit_list_due"
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      repository: row.repository,
      ref: row.ref_name,
      locale: row.locale,
      releaseId: row.release_id,
      commitSha: row.commit_sha,
      publicSnapshotDigest: row.public_snapshot_digest
    }));
  }

  async recordFollowup(
    input: WikiAuditFollowupRecord
  ): Promise<{ readonly record: WikiAuditFollowupRecord; readonly created: boolean }> {
    const normalized = normalizeFollowup(input);
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [normalized.tenantId] },
      async (client) => {
        const inserted = await client.query<FollowupRow>(
          `insert into jina_context.context_release_audit_followups (${FOLLOWUP_COLUMNS})
           select $1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9::timestamptz
           where exists (
             select 1 from jina_context.context_release_audits
             where audit_id=$1 and tenant_id=$2 and repository=$3
           )
           on conflict do nothing
           returning ${FOLLOWUP_COLUMNS}`,
          followupValues(normalized)
        );
        if (inserted.rows[0]) return { record: followupFromRow(inserted.rows[0]), created: true };
        const existing = await client.query<FollowupRow>(
          `select ${FOLLOWUP_COLUMNS} from jina_context.context_release_audit_followups
           where audit_id=$1 or request_key=$2 for share`,
          [normalized.auditId, normalized.requestKey]
        );
        const record = existing.rows[0] ? followupFromRow(existing.rows[0]) : undefined;
        if (!record) throw new Error("wiki audit follow-up references an unknown audit");
        if (fingerprint(record) !== fingerprint(normalized)) {
          throw new Error("wiki audit follow-up is already bound to a different immutable decision");
        }
        return { record, created: false };
      },
      "wiki_audit_record_followup"
    );
  }
}

function normalizeAudit(input: WikiReleaseAuditRecord): WikiReleaseAuditRecord {
  const tenantId = requiredText(input.tenantId, "tenantId", 240);
  const repository = normalizeRepository(input.repository);
  const auditId = requiredText(input.auditId, "auditId", 240);
  const releaseId = requiredText(input.releaseId, "releaseId", 240);
  const locale = localeValue(input.locale);
  const auditInputDigest = digest(input.auditInputDigest, "auditInputDigest");
  const summaryBytes = Buffer.byteLength(JSON.stringify(input.summary), "utf8");
  if (!isRecord(input.summary) || summaryBytes > 65_536) throw new Error("wiki audit summary is invalid or too large");
  const reportArtifact = validateWikiAuditReportArtifactRef(input.reportArtifact, {
    tenantId,
    repository,
    auditId,
    releaseId,
    auditInputDigest
  });
  return {
    auditId,
    tenantId,
    repository,
    releaseId,
    locale,
    publicSnapshotDigest: digest(input.publicSnapshotDigest, "publicSnapshotDigest"),
    auditPolicyVersion: requiredText(input.auditPolicyVersion, "auditPolicyVersion", 240),
    auditorConfigDigest: digest(input.auditorConfigDigest, "auditorConfigDigest"),
    auditWindow: requiredText(input.auditWindow, "auditWindow", 240),
    auditInputDigest,
    triggerRunId: requiredText(input.triggerRunId, "triggerRunId", 240),
    outcome: enumValue(input.outcome, ["passed", "needs_improvement", "error"] as const, "outcome"),
    summary: input.summary,
    reportArtifact,
    completedAt: new Date(input.completedAt).toISOString()
  };
}

function normalizeRunClaim(input: WikiAuditRunClaim): WikiAuditRunClaim {
  return {
    auditId: requiredText(input.auditId, "auditId", 240),
    tenantId: requiredText(input.tenantId, "tenantId", 240),
    repository: normalizeRepository(input.repository),
    releaseId: requiredText(input.releaseId, "releaseId", 240),
    locale: localeValue(input.locale),
    publicSnapshotDigest: digest(input.publicSnapshotDigest, "publicSnapshotDigest"),
    auditPolicyVersion: requiredText(input.auditPolicyVersion, "auditPolicyVersion", 240),
    auditorConfigDigest: digest(input.auditorConfigDigest, "auditorConfigDigest"),
    auditWindow: requiredText(input.auditWindow, "auditWindow", 240),
    auditInputDigest: digest(input.auditInputDigest, "auditInputDigest"),
    triggerRunId: requiredText(input.triggerRunId, "triggerRunId", 240),
    claimedAt: new Date(input.claimedAt).toISOString()
  };
}

function normalizeFollowup(input: WikiAuditFollowupRecord): WikiAuditFollowupRecord {
  const outcome = enumValue(
    input.admissionOutcome,
    ["admitted", "already_admitted", "superseded", "policy_denied"] as const,
    "admissionOutcome"
  );
  if ((outcome === "admitted" || outcome === "already_admitted") && !input.boardBuildId) {
    throw new Error("admitted wiki audit follow-up requires boardBuildId");
  }
  return {
    auditId: requiredText(input.auditId, "auditId", 240),
    tenantId: requiredText(input.tenantId, "tenantId", 240),
    repository: normalizeRepository(input.repository),
    requestKey: requiredText(input.requestKey, "requestKey", 512),
    ...(input.boardBuildId ? { boardBuildId: requiredText(input.boardBuildId, "boardBuildId", 240) } : {}),
    ...(input.currentReleaseIdAtDecision
      ? {
          currentReleaseIdAtDecision: requiredText(input.currentReleaseIdAtDecision, "currentReleaseIdAtDecision", 240)
        }
      : {}),
    ...(input.admittedAt ? { admittedAt: new Date(input.admittedAt).toISOString() } : {}),
    admissionOutcome: outcome,
    decidedAt: new Date(input.decidedAt).toISOString()
  };
}

function auditValues(record: WikiReleaseAuditRecord): unknown[] {
  return [
    record.auditId,
    record.tenantId,
    record.repository,
    record.releaseId,
    record.locale,
    record.publicSnapshotDigest,
    record.auditPolicyVersion,
    record.auditorConfigDigest,
    record.auditWindow,
    record.auditInputDigest,
    record.triggerRunId,
    record.outcome,
    JSON.stringify(record.summary),
    JSON.stringify(record.reportArtifact),
    record.completedAt
  ];
}

function auditRunValues(record: WikiAuditRunClaim): unknown[] {
  return [
    record.auditId,
    record.tenantId,
    record.repository,
    record.releaseId,
    record.locale,
    record.publicSnapshotDigest,
    record.auditPolicyVersion,
    record.auditorConfigDigest,
    record.auditWindow,
    record.auditInputDigest,
    record.triggerRunId,
    record.claimedAt
  ];
}

function runClaimIdentity(record: WikiAuditRunClaim): Omit<WikiAuditRunClaim, "claimedAt"> {
  const { claimedAt: _claimedAt, ...identity } = record;
  return identity;
}

function followupValues(record: WikiAuditFollowupRecord): unknown[] {
  return [
    record.auditId,
    record.tenantId,
    record.repository,
    record.requestKey,
    record.boardBuildId ?? null,
    record.currentReleaseIdAtDecision ?? null,
    record.admittedAt ?? null,
    record.admissionOutcome,
    record.decidedAt
  ];
}

function auditFromRow(row: AuditRow): WikiReleaseAuditRecord {
  return normalizeAudit({
    auditId: row.audit_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    releaseId: row.release_id,
    locale: row.locale,
    publicSnapshotDigest: row.public_snapshot_digest,
    auditPolicyVersion: row.audit_policy_version,
    auditorConfigDigest: row.auditor_config_digest,
    auditWindow: row.audit_window,
    auditInputDigest: row.audit_input_digest,
    triggerRunId: row.trigger_run_id,
    outcome: row.outcome,
    summary: recordValue(row.summary),
    reportArtifact: row.report_artifact as WikiAuditReportArtifactRef,
    completedAt: dateString(row.completed_at)
  });
}

function auditRunFromRow(row: AuditRunRow): WikiAuditRunClaim {
  return normalizeRunClaim({
    auditId: row.audit_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    releaseId: row.release_id,
    locale: row.locale,
    publicSnapshotDigest: row.public_snapshot_digest,
    auditPolicyVersion: row.audit_policy_version,
    auditorConfigDigest: row.auditor_config_digest,
    auditWindow: row.audit_window,
    auditInputDigest: row.audit_input_digest,
    triggerRunId: row.trigger_run_id,
    claimedAt: dateString(row.claimed_at)
  });
}

function followupFromRow(row: FollowupRow): WikiAuditFollowupRecord {
  return normalizeFollowup({
    auditId: row.audit_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    requestKey: row.request_key,
    ...(row.board_build_id ? { boardBuildId: row.board_build_id } : {}),
    ...(row.current_release_id_at_decision ? { currentReleaseIdAtDecision: row.current_release_id_at_decision } : {}),
    ...(row.admitted_at ? { admittedAt: dateString(row.admitted_at) } : {}),
    admissionOutcome: row.admission_outcome,
    decidedAt: dateString(row.decided_at)
  });
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0"))
    throw new Error(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function localeValue(value: string): string {
  const locale = requiredText(value, "locale", 64).toLowerCase();
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(locale)) throw new Error("locale is invalid");
  return locale;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("wiki audit summary row is invalid");
  return value;
}
