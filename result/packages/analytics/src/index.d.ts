export type AnalyticsEventName = 'login.click' | 'auth.oauth.completed' | 'minecraft.verification.completed' | 'minecraft.verification.failed' | 'minecraft.verification.revoked' | 'vote.submitted' | 'review.submitted';
export interface AnalyticsEventPayloadMap {
    'login.click': {
        provider: 'discord' | 'naver' | 'email';
    };
    'auth.oauth.completed': {
        provider: 'discord' | 'naver';
        success: boolean;
        error?: string;
    };
    'minecraft.verification.completed': {
        userId: string;
        uuid: string;
    };
    'minecraft.verification.failed': {
        userId: string;
        reason: string;
    };
    'minecraft.verification.revoked': {
        userId: string;
        removed: boolean;
    };
    'vote.submitted': {
        serverId: string;
        username: string;
        voterKey: string;
        ipAddress?: string;
    };
    'review.submitted': {
        serverId: string;
        reviewId: string;
        rating: number;
        tags: readonly string[];
        author: string;
    };
}
export type AnalyticsEvent<Name extends AnalyticsEventName = AnalyticsEventName> = {
    name: Name;
    timestamp: string;
    payload: AnalyticsEventPayloadMap[Name];
};
export type AnalyticsListener = (event: AnalyticsEvent) => void | Promise<void>;
export declare function registerAnalyticsListener(listener: AnalyticsListener): () => void;
export declare function trackEvent<Name extends AnalyticsEventName>(name: Name, payload: AnalyticsEventPayloadMap[Name]): Promise<void>;
