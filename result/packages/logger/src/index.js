"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservabilityExporter = exports.Logger = void 0;
const pino_1 = __importDefault(require("pino"));
exports.Logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname'
            }
        }
});
var observability_1 = require("./observability");
Object.defineProperty(exports, "ObservabilityExporter", { enumerable: true, get: function () { return observability_1.ObservabilityExporter; } });
//# sourceMappingURL=index.js.map