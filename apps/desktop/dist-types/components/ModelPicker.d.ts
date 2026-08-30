import { type ReactNode } from 'react';
import { type Connection, type GpuType, type ModelVerdict } from '../lib/api.js';
/**
 * Picks a model for one slot and says, before anything is rented, whether it
 * will actually run on the chosen card.
 *
 * The verdict is the point. Weight format against engine, format against GPU,
 * and size against VRAM are each a way for a choice to fail four minutes into a
 * download that is already being billed.
 */
export declare function ModelPicker({ connection, kind, engine, gpu, otherSlotBytes, value, onChange, }: {
    connection: Connection;
    kind: 'chat' | 'embedding';
    engine: 'vllm' | 'llamacpp';
    gpu: GpuType | null;
    otherSlotBytes: number;
    value: string;
    onChange: (repoId: string, verdict: ModelVerdict | null) => void;
}): ReactNode;
//# sourceMappingURL=ModelPicker.d.ts.map