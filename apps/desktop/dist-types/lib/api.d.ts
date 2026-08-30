import type { Problem, PublicSettings, Template } from '@runpod-launcher/shared';
/**
 * Talks to the launcher service.
 *
 * The device token lives in the browser's local storage during development and
 * in the OS keychain once the Tauri shell wraps this; either way it is set once
 * at pairing and never typed again.
 */
export declare class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export interface Connection {
    baseUrl: string;
    token: string;
}
export interface PodView {
    pod: {
        id: string;
        templateId: string;
        status: string;
        costPerHour: number;
    } | null;
    serving: {
        chatUrl: string | null;
        embeddingUrl: string | null;
        servedModels: string[];
    } | null;
}
export interface GpuType {
    id: string;
    name: string;
    memory: number;
    price: {
        secure?: number;
        community?: number;
    };
    availability?: 'HIGH' | 'MEDIUM' | 'LOW' | string;
}
export interface ModelHit {
    repoId: string;
    downloads: number;
    pipelineTag: string | null;
    gated: boolean;
}
export interface ModelVerdict {
    details: {
        repoId: string;
        weightBytes: number;
        format: string;
        gated: boolean;
        ggufVariants?: Array<{
            label: string;
            bytes: number;
            files: string[];
        }>;
    };
    compatible: boolean;
    problems: Problem[];
    headroomGib: number | null;
}
export interface ClientToken {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}
export declare const api: {
    /** Exchanges a pairing code for a device token. Needs no token itself. */
    pair(baseUrl: string, code: string, deviceName: string): Promise<{
        token: string;
        deviceId: string;
    }>;
    health: (baseUrl: string) => Promise<any>;
    settings: (c: Connection) => Promise<PublicSettings>;
    saveSettings: (c: Connection, patch: Record<string, unknown>) => Promise<PublicSettings>;
    verifyRunpodKey: (c: Connection) => Promise<{
        valid: boolean;
        error?: string;
    }>;
    templates: (c: Connection) => Promise<{
        templates: Template[];
    }>;
    createTemplate: (c: Connection, template: Record<string, unknown>) => Promise<{
        id: string;
        name: string;
        engine: "vllm" | "llamacpp";
        image: string;
        chatModel: {
            repoId: string;
            revision?: string | undefined;
            servedName?: string | undefined;
            gpuMemoryFraction?: number | undefined;
        } | null;
        embeddingModel: {
            repoId: string;
            revision?: string | undefined;
            servedName?: string | undefined;
            gpuMemoryFraction?: number | undefined;
        } | null;
        gpuTypeId: string;
        gpuFallbackIds: string[];
        gpuCount: number;
        cloud: "SECURE" | "COMMUNITY";
        dataCenterIds: string[];
        containerDiskGb: number;
        networkVolumeId: string | null;
        networkVolumeMountPath: string;
        env: Record<string, string>;
        lifecycleMode: "stopResume" | "recreate";
        schedule: {
            enabled: boolean;
            timezone: string;
            weekdays: number[];
            idleStopMinutes: number;
            maxRuntimeHours: number;
            startAt?: string | undefined;
            stopAt?: string | undefined;
        };
        maxModelLen?: number | undefined;
        maxConcurrentSequences?: number | undefined;
        args?: string | undefined;
    }>;
    pod: (c: Connection) => Promise<PodView>;
    startPod: (c: Connection, templateId: string) => Promise<{
        id: string;
    }>;
    stopPod: (c: Connection) => Promise<{
        stopped: string | null;
    }>;
    gpus: (c: Connection) => Promise<{
        gpus: GpuType[];
    }>;
    searchModels: (c: Connection, q: string, kind: "chat" | "embedding") => Promise<{
        models: ModelHit[];
    }>;
    evaluateModel: (c: Connection, body: Record<string, unknown>) => Promise<ModelVerdict>;
    clientTokens: (c: Connection) => Promise<{
        tokens: ClientToken[];
    }>;
    createClientToken: (c: Connection, name: string) => Promise<{
        id: string;
        token: string;
    }>;
    revokeClientToken: (c: Connection, id: string) => Promise<void>;
};
//# sourceMappingURL=api.d.ts.map