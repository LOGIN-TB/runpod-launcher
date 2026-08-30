import { type ReactNode } from 'react';
import { type Connection } from '../lib/api.js';
/**
 * Credentials and limits.
 *
 * Secrets are write-only from here: the service returns `hasRunpodApiKey`
 * rather than the key, so this screen can show that one is set without ever
 * holding it. Leaving a field blank means "leave it alone", which is what lets
 * the form be submitted without echoing back a value it was never shown.
 */
export declare function Settings({ connection }: {
    connection: Connection;
}): ReactNode;
//# sourceMappingURL=Settings.d.ts.map