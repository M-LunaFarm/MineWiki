"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservabilityExporter = void 0;
const index_1 = require("./index");
class ObservabilityExporter {
    constructor(options = {}) {
        this.endpoint = options.endpoint;
        this.apiKey = options.apiKey;
        this.enabled = options.enabled ?? Boolean(options.endpoint);
        this.source = options.source ?? 'api';
    }
    async report(event) {
        if (!this.enabled || !this.endpoint) {
            index_1.Logger.debug({ event }, 'Observability exporter disabled or endpoint missing');
            return;
        }
        const payload = (() => {
            switch (event.type) {
                case 'queue':
                    return {
                        ...event,
                        source: 'worker'
                    };
                case 'firestore':
                    return {
                        ...event,
                        source: 'api'
                    };
                default:
                    return {
                        ...event,
                        source: (event.source ?? this.source)
                    };
            }
        })();
        try {
            await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
                },
                body: JSON.stringify(payload)
            });
        }
        catch (error) {
            index_1.Logger.warn({ err: error }, 'Failed to export observability event');
        }
    }
}
exports.ObservabilityExporter = ObservabilityExporter;
//# sourceMappingURL=observability.js.map