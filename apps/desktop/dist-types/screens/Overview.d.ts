import { type ReactNode } from 'react';
import type { Template } from '@runpod-launcher/shared';
import { type Connection } from '../lib/api.js';
/**
 * The screen you open nine times out of ten to answer one question: is it
 * running, and what is it costing me? Everything else is one click away.
 */
export declare function Overview({ connection, templates, onGoToTemplates, }: {
    connection: Connection;
    templates: Template[];
    onGoToTemplates: () => void;
}): ReactNode;
//# sourceMappingURL=Overview.d.ts.map