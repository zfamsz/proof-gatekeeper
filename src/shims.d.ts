/**
 * Minimal ambient declarations for snarkjs / circomlibjs (no bundled
 * types ship with these versions). Kept narrow on purpose.
 */
declare module "snarkjs" {
  export namespace groth16 {
    function fullProve(
      input: Record<string, string>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    function verify(
      vk: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  }
}

declare module "circomlibjs" {
  export function buildPoseidon(): Promise<{
    (inputs: (bigint | string)[]): unknown;
    F: { toString(v: unknown): string };
  }>;
}
