/** DeepSeek Harness presentation revision required by this Workbench release. */
export interface SupportedHarnessBuild {
  /** Harness release used for module and type compatibility. */
  readonly version: string
  /** Session presentation interface revision. */
  readonly protocol: number
}

/** Workbench 0.2 targets the first latest-Harness presentation interface. */
export const SUPPORTED_HARNESS: SupportedHarnessBuild = {
  version: '0.1.1-rc.2',
  protocol: 2,
}
