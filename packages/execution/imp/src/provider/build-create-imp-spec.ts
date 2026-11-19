import type { ImpCreateSpec } from '../port/imp-port';
import type { ImpTargetOptions } from './types';

// impd fills in its own default for any of these fields left out of the spec.
export function buildCreateImpSpec(name: string, target: ImpTargetOptions): ImpCreateSpec {
  return {
    name,
    ...(target.image === undefined ? {} : { image: target.image }),
    ...(target.memoryMib === undefined ? {} : { memoryMib: target.memoryMib }),
    ...(target.maxMemoryMib === undefined ? {} : { maxMemoryMib: target.maxMemoryMib }),
  };
}
