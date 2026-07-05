export type ObservabilityEvent = {
    readonly source: 'api' | 'worker';
    readonly type: 'http';
    readonly name: string;
    readonly durationMs: number;
    readonly statusCode: number;
    readonly attributes?: Record<string, unknown>;
    readonly timestamp: string;
} | {
    readonly source: 'worker';
    readonly type: 'queue';
    readonly queue: string;
    readonly jobId: string;
    readonly jobName?: string;
    readonly status: 'completed' | 'failed';
    readonly durationMs: number;
    readonly attempts: number;
    readonly error?: string;
    readonly timestamp: string;
} | {
    readonly source: 'api';
    readonly type: 'firestore';
    readonly operation: string;
    readonly collection?: string;
    readonly success: boolean;
    readonly durationMs: number;
    readonly error?: string;
    readonly timestamp: string;
} | {
    readonly source: 'api' | 'worker';
    readonly type: 'sentry';
    readonly level?: string;
    readonly message?: string;
    readonly exception?: string;
    readonly timestamp: string;
};
export interface ObservabilityExporterOptions {
    readonly endpoint?: string;
    readonly apiKey?: string;
    readonly enabled?: boolean;
    readonly source?: 'api' | 'worker';
}
export declare class ObservabilityExporter {
    private readonly endpoint?;
    private readonly apiKey?;
    private readonly enabled;
    private readonly source;
    constructor(options?: ObservabilityExporterOptions);
    report(event: ObservabilityEvent): Promise<void>;
}
