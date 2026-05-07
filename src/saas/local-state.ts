export type SaasLocalStateClassification =
  | "tenant-owned-before-exposure"
  | "operator-only-until-modeled"
  | "self-hosted-only";

export type SaasLocalStateStore = {
  id: string;
  relativePath: string;
  classification: SaasLocalStateClassification;
  migrationRequirement: string;
};

const LOCAL_STATE_STORES: readonly SaasLocalStateStore[] = [
  {
    id: "task-registry",
    relativePath: "tasks/runs.sqlite",
    classification: "operator-only-until-modeled",
    migrationRequirement:
      "Do not expose through tenant APIs until PostgreSQL task_runs and task_delivery_state tables exist.",
  },
  {
    id: "memory-store",
    relativePath: "memory/{agentId}.sqlite",
    classification: "tenant-owned-before-exposure",
    migrationRequirement:
      "Move or re-embed tenant memory into tenant-scoped memory_embeddings before exposing memory search in SaaS.",
  },
  {
    id: "auth-profiles",
    relativePath: "agents/{agentId}/agent/auth-profiles.json",
    classification: "tenant-owned-before-exposure",
    migrationRequirement:
      "Import credentials into tenant_secrets and disable main-agent inheritance in shared SaaS runtimes.",
  },
  {
    id: "exec-secret-providers",
    relativePath: "openclaw.json:secrets.providers[].exec",
    classification: "self-hosted-only",
    migrationRequirement:
      "Replace with tenant_secrets vault references; do not run exec-backed secret providers in shared SaaS.",
  },
] as const;

export function listSaasLocalStateStores(): readonly SaasLocalStateStore[] {
  return LOCAL_STATE_STORES;
}

export function getSaasLocalStateStore(id: string): SaasLocalStateStore | undefined {
  return LOCAL_STATE_STORES.find((store) => store.id === id);
}
