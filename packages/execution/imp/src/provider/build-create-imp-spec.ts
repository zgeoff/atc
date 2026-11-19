import type { ImpCreateSpec } from '../port/imp-port';
import type { ImpTargetOptions } from './types';

// The imp a target creates: its image, memory and memory max when the target
// sets them, and impd's defaults otherwise.
export function buildCreateImpSpec(name: string, target: ImpTargetOptions): ImpCreateSpec {
  return {
    name,
    ...(target.image === undefined ? {} : { image: target.image }),
    ...(target.memoryMib === undefined ? {} : { memoryMib: target.memoryMib }),
    ...(target.maxMemoryMib === undefined ? {} : { maxMemoryMib: target.maxMemoryMib }),
  };
}
