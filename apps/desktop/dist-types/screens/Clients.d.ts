import { type ReactNode } from 'react';
import { type Connection } from '../lib/api.js';
/**
 * Client tokens, and the recipes for using them.
 *
 * The recipes matter as much as the tokens: the endpoint is a plain
 * OpenAI-compatible one, and most of the work in adopting it is knowing which
 * box to paste the address into for a given tool.
 */
export declare function Clients({ connection }: {
    connection: Connection;
}): ReactNode;
//# sourceMappingURL=Clients.d.ts.map