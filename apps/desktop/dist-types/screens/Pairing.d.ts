import { type ReactNode } from 'react';
import { type Connection } from '../lib/api.js';
/**
 * First contact. Everything else in the app is unreachable until this succeeds,
 * so it has to explain itself without assuming the reader knows what a
 * container log is.
 */
export declare function Pairing({ onPaired }: {
    onPaired: (connection: Connection) => void;
}): ReactNode;
//# sourceMappingURL=Pairing.d.ts.map