export type AddressFamily = 4 | 6;
export interface ResolvedAddress {
    readonly address: string;
    readonly family: AddressFamily;
}
export interface OutboundTarget {
    readonly host: string;
    readonly port: number;
    readonly addresses: readonly ResolvedAddress[];
}
export interface OutboundValidationOptions {
    readonly label?: string;
    readonly allowIpv6?: boolean;
    readonly allowedPorts?: readonly number[];
}
type UnsafeReason = 'invalid_host' | 'invalid_port' | 'ipv6_not_allowed' | 'private_address' | 'resolve_failed';
export declare class UnsafeEndpointError extends Error {
    readonly reason: UnsafeReason;
    constructor(reason: UnsafeReason, message: string);
}
export declare function validateOutboundTarget(host: string, port: number, options?: OutboundValidationOptions): Promise<OutboundTarget>;
export { validateImageUpload, ImageValidationError } from './upload';
export type { SanitizedImage } from './upload';
