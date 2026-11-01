// Shared sandbox (microVM) types. `VmRow` mirrors the control-plane camelCase
// vmRow JSON; everything here comes from the API, nothing is simulated.

export type VmState =
  | "pending"
  | "spawning"
  | "running"
  | "paused"
  | "draining"
  | "terminated"
  | "failed";

export interface VmRow {
  vmId: string;
  state: VmState;
  node: string | null;
  region?: string | null;
  az?: string | null;
  isolationClass: string;
  createdAt: string;
  terminatedAt?: string | null;
  lastHeartbeatAt?: string | null;
  spec: Record<string, unknown> | null;
  /** Why the VM is in its current state (failures carry the cause). */
  stateReason?: string | null;
  /** Set once the VM has been paused/snapshotted. */
  snapshotId?: string | null;
  /** Set on VMs created by fork. */
  parentVmId?: string | null;

}

export interface ClusterNode {
  name: string;
  region: string;
  availability_zone: string;
  running_vms: number;
  free_vcpu_millis: number;
  free_memory_bytes: number;
  // Totals may be omitted by the live endpoint.
  total_vcpu_millis?: number;
  total_memory_bytes?: number;
  draining: boolean;
}

export interface ClusterSummary {
  total_vms_running: number;
  total_vms_pending: number;
  nodes: ClusterNode[];
  warm_pool?: {
    available: number;
    target: number;
    regions?: Record<string, number>;
  };
}
