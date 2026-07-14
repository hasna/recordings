import { hostname } from "node:os";

export function currentMachineId(
  env: NodeJS.ProcessEnv = process.env,
  hostName: string = hostname(),
): string {
  const configured = env.HASNA_MACHINE_ID?.trim();
  if (configured) return configured;
  return hostName.trim();
}
