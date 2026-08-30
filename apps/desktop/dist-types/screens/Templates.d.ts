import { type ReactNode } from 'react';
import type { Template } from '@runpod-launcher/shared';
import { type Connection } from '../lib/api.js';
export declare function Templates({ connection, templates, onChanged, }: {
    connection: Connection;
    templates: Template[];
    onChanged: () => void;
}): ReactNode;
//# sourceMappingURL=Templates.d.ts.map