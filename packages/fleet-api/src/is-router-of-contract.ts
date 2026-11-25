import { isRecord } from '@atc/core';
import { isProcedure, traverseContractProcedures } from '@orpc/server';
import type { ContractRouter, Meta, Router } from '@orpc/server';
import type { FleetContext } from './types';

// True when the tree holds an oRPC procedure at every path of the contract, which is what makes it
// a router of that contract.
export function isRouterOfContract<TContract extends ContractRouter<Meta>>(
  contract: TContract,
  tree: unknown,
): tree is Router<TContract, FleetContext> {
  let isComplete = true;

  traverseContractProcedures({ router: contract, path: [] }, (entry) => {
    let node: unknown = tree;

    for (const key of entry.path) {
      node = isRecord(node) ? node[key] : undefined;
    }

    isComplete &&= isProcedure(node);
  });

  return isComplete;
}
