/** POST path for agent creation. createOnly makes the server answer 409 agent_exists instead of upserting. */
export function createAgentPath(opts?: { createOnly?: boolean }): string {
  return opts?.createOnly ? "/v1/agents?createOnly=1" : "/v1/agents";
}
