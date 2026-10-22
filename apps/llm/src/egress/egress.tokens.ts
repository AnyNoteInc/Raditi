/** StreamingEgress of every request to a provider, the gateway's and the probes': ungated. */
export const EGRESS_TRANSPORT = Symbol('EGRESS_TRANSPORT')
/** StreamingEgress of generations: open while the channel works and no region block holds. */
export const GENERATION_EGRESS = Symbol('GENERATION_EGRESS')
/** EgressHttp of the pool's account probes, behind the gate of generations. */
export const CONTROL_HTTP = Symbol('CONTROL_HTTP')
/** EgressHttp gated by the channel alone: the one account probe that may lift a region block. */
export const REGION_HTTP = Symbol('REGION_HTTP')
