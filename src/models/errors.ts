import type { ModelDiscoveryErrorKind } from "./types.js";

export class ModelDiscoveryError extends Error {
  constructor(
    public readonly kind: ModelDiscoveryErrorKind,
    message: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}
