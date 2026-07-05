"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAnalyticsListener = registerAnalyticsListener;
exports.trackEvent = trackEvent;
const logger_1 = require("@creepervote/logger");
const listeners = new Set();
function registerAnalyticsListener(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
async function trackEvent(name, payload) {
    const event = {
        name,
        timestamp: new Date().toISOString(),
        payload
    };
    logger_1.Logger.info({ event }, 'Analytics event emitted');
    for (const listener of listeners) {
        try {
            await listener(event);
        }
        catch (error) {
            logger_1.Logger.error({ err: error }, 'Analytics listener threw an error');
        }
    }
}
//# sourceMappingURL=index.js.map