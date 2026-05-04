import type { Method } from "mppx";
import { charge as charge_ } from "./Charge.js";


export function arbitrum(
  parameters: charge_.Parameters,
): readonly [Method.AnyServer] {
  return [arbitrum.charge(parameters)] as const;
}

export namespace arbitrum {
  export type Parameters = charge_.Parameters

  export const charge = charge_;
}