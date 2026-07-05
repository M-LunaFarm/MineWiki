export interface ImageValidationOptions {
    readonly maxBytes?: number;
    readonly maxDimension?: number;
}
export interface SanitizedImage {
    readonly buffer: Buffer;
    readonly mimeType: string;
    readonly extension: string;
    readonly width: number;
    readonly height: number;
    readonly originalSize: number;
}
export declare class ImageValidationError extends Error {
    constructor(message: string);
}
export declare function validateImageUpload(buffer: Buffer, originalName: string, options?: ImageValidationOptions): Promise<SanitizedImage>;
