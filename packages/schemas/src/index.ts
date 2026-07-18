import { z } from 'zod';

export * from './worker-health';

export const CURRENT_POLICY_VERSIONS = {
  terms: {
    version: 'v1.2',
    consentVersion: '2026-07-15-v1.2',
    effectiveDate: '2026-07-15',
  },
  privacy: {
    version: 'v1.2',
    consentVersion: '2026-07-15-v1.2',
    effectiveDate: '2026-07-15',
  },
} as const;

export const authProviderSchema = z.enum(['email', 'discord', 'naver']);
export const oauthProviderSchema = z.enum(['discord', 'naver']);

export const linkedAccountSchema = z.object({
  id: z.string().uuid(),
  provider: authProviderSchema,
  email: z.string().email().nullable().optional(),
  displayName: z.string().min(1).max(32).nullable().optional(),
});

export const policyConsentStatusSchema = z.object({
  required: z.boolean(),
  terms: z.object({
    currentVersion: z.string().min(1),
    acceptedVersion: z.string().min(1).nullable(),
    accepted: z.boolean(),
  }),
  privacy: z.object({
    currentVersion: z.string().min(1),
    acceptedVersion: z.string().min(1).nullable(),
    accepted: z.boolean(),
  }),
});

export const authAccountSchema = z.object({
  id: z.string().uuid(),
  provider: authProviderSchema,
  providerUserId: z.string().min(1),
  email: z.string().email().nullable().optional(),
  displayName: z.string().min(1).max(32).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  emailVerified: z.boolean(),
  hasPassword: z.boolean(),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
  linkedAccountIds: z.array(z.string().uuid()),
  linkedAccounts: z.array(linkedAccountSchema),
  policyConsent: policyConsentStatusSchema.optional(),
  access: z
    .object({
      isElevated: z.boolean(),
      authLevel: z.enum(['aal1', 'aal2']).optional(),
      stepUpExpiresAt: z.string().datetime().nullable().optional(),
      stepUpPurpose: z.string().nullable().optional(),
      roles: z.array(z.string()),
      permissions: z.array(z.string()),
    })
    .optional(),
});

export const oauthStartRequestSchema = z.object({
  provider: oauthProviderSchema,
  redirectUri: z.string().url().optional(),
  returnTo: z.string().min(1).optional(),
  agreeTerms: z.boolean().optional(),
  agreePrivacy: z.boolean().optional(),
});

export const oauthStartResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string().min(8),
  expiresAt: z.string().datetime(),
});

export const oauthCompleteRequestSchema = z.object({
  provider: oauthProviderSchema,
  code: z.string().min(1),
  state: z.string().min(8),
  redirectUri: z.string().url().optional(),
});

export const oauthCompleteResponseSchema = z.discriminatedUnion('consentRequired', [z.object({
  consentRequired: z.literal(false),
  account: authAccountSchema,
  sessionId: z.string().min(1),
  expiresAt: z.string().datetime(),
  returnTo: z.string().min(1).nullable(),
  mode: z.enum(['login', 'link']),
}), z.object({
  consentRequired: z.literal(true),
  provider: oauthProviderSchema,
  returnTo: z.string().min(1).nullable(),
})]);

export const oauthSignupConsentRequestSchema = z.object({
  agreeTerms: z.literal(true),
  agreePrivacy: z.literal(true),
}).strict();

const emailAddressSchema = z.string().trim().email().max(254);
const authPasswordSchema = z.string().min(1).max(128);

export const emailRegistrationRequestSchema = z
  .object({
    email: emailAddressSchema,
    password: authPasswordSchema,
    displayName: z.string().trim().min(1).max(32).optional(),
    agreeTerms: z.literal(true),
    agreePrivacy: z.literal(true),
  })
  .strict();

export const emailLoginRequestSchema = z
  .object({
    email: emailAddressSchema,
    password: authPasswordSchema,
  })
  .strict();

export const emailVerificationRequestSchema = z
  .object({ token: z.string().trim().min(1).max(512) })
  .strict();

export const emailResendRequestSchema = z.object({ email: emailAddressSchema }).strict();

export const emailLoginSetupRequestSchema = emailLoginRequestSchema;

export const passwordResetRequestSchema = z.object({ email: emailAddressSchema }).strict();

export const passwordResetConfirmRequestSchema = z
  .object({
    token: z.string().trim().min(1).max(512),
    newPassword: authPasswordSchema,
  })
  .strict();

export const passwordChangeRequestSchema = z
  .object({
    currentPassword: authPasswordSchema,
    newPassword: authPasswordSchema,
  })
  .strict();

export const accountDeletionRequestSchema = z
  .object({ password: authPasswordSchema.optional() })
  .strict();

export const accountDeletionCancelSchema = z
  .object({ cancelToken: z.string().trim().min(32).max(256) })
  .strict();

export const accountDeletionAdminActionSchema = z
  .object({ note: z.string().trim().max(1000).optional() })
  .strict();

export const accountLifecycleStatusSchema = z.enum([
  'active',
  'suspended',
  'deletion_pending',
  'anonymized',
]);

export const accountModerationActionSchema = z
  .object({
    reason: z.string().trim().min(5).max(1000),
    confirmation: z.string().uuid(),
    expectedStatus: z.enum(['active', 'suspended']),
  })
  .strict();

export const accountSuspendActionSchema = accountModerationActionSchema.extend({
  expectedStatus: z.literal('active'),
}).strict();

export const accountRestoreActionSchema = accountModerationActionSchema.extend({
  expectedStatus: z.literal('suspended'),
}).strict();

export const adminAccountListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(128).optional(),
    status: accountLifecycleStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const adminAccountSummarySchema = z.object({
  canonicalAccountId: z.string().uuid(),
  confirmationValue: z.string().uuid(),
  accountIds: z.array(z.string().uuid()).min(1),
  linkedAccountCount: z.number().int().nonnegative(),
  lifecycleStatus: z.union([accountLifecycleStatusSchema, z.literal('mixed')]),
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
  providers: z.array(authProviderSchema),
  roles: z.array(z.string()),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
  suspendedAt: z.string().datetime().nullable(),
  suspendedBy: z.string().nullable(),
  suspensionReason: z.string().nullable(),
});

export const adminAccountMemberSchema = z.object({
  id: z.string().uuid(),
  provider: authProviderSchema,
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
  lifecycleStatus: accountLifecycleStatusSchema,
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
});

export const accountModerationHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['account.suspended', 'account.restored']),
  actorAccountId: z.string().nullable(),
  reason: z.string().nullable(),
  previousStatus: z.string().nullable(),
  newStatus: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const adminAccountDetailSchema = adminAccountSummarySchema.extend({
  accounts: z.array(adminAccountMemberSchema).min(1),
  moderationHistory: z.array(accountModerationHistoryEntrySchema),
});

export const adminAccountListResponseSchema = z.object({
  accounts: z.array(adminAccountSummarySchema),
});

export const accountModerationResultSchema = z.object({
  account: adminAccountDetailSchema,
  revokedSessionCount: z.number().int().nonnegative(),
  revokedWikiApiTokenCount: z.number().int().nonnegative(),
});

export const policyConsentAcceptRequestSchema = z
  .object({
    agreeTerms: z.literal(true),
    agreePrivacy: z.literal(true),
  })
  .strict();

export const emailRegistrationResultSchema = z.object({
  status: z.literal('verification-required'),
  accountId: z.string().uuid(),
  email: z.string().email(),
  expiresAt: z.string().datetime(),
});

export const resendVerificationResultSchema = z.object({
  email: z.string().email(),
  expiresAt: z.string().datetime(),
});

export const sessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
  createdAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  isCurrent: z.boolean(),
  tokenVersion: z.number().int().positive(),
  isElevated: z.boolean(),
  authLevel: z.enum(['aal1', 'aal2']).optional(),
  stepUpExpiresAt: z.string().datetime().nullable().optional(),
});

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});

export const minecraftIdentitySchema = z.object({
  uuid: z.string().uuid(),
  playerName: z.string().min(1).optional(),
  msOwned: z.boolean(),
  isPrimary: z.boolean().optional(),
  lastVerifiedAt: z.string().datetime(),
});

export const minecraftIdentityListSchema = z.object({
  identities: z.array(minecraftIdentitySchema),
});

export const minecraftVerificationRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  authorizationCode: z.string().min(1),
  redirectUri: z.string().url().optional(),
  state: z.string().min(8).optional(),
});

export const minecraftAuthorizationStartRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  redirectUri: z.string().url().optional(),
});

export const minecraftAuthorizationStartResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string().min(8),
});

export const userAccountSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(32),
  authProvider: authProviderSchema,
  createdAt: z.string().datetime(),
  minecraftIdentity: minecraftIdentitySchema.nullable(),
  minecraftIdentities: z.array(minecraftIdentitySchema).optional(),
});

export const serverVerificationGradeSchema = z.enum(['Verified', 'Unverified']);
export const claimMethodSchema = z.enum(['plugin', 'dns', 'motd']);
export const PUBLIC_SERVER_LISTING_STATUS = 'active' as const;

export const serverSummarySchema = z.object({
  id: z.string().uuid(),
  shortCode: z.string().min(5).max(12).regex(/^[a-z0-9]+$/).nullable().optional(),
  wikiSpaceId: z.string().min(1).nullable().optional(),
  wikiPageId: z.string().min(1).nullable().optional(),
  wikiSlug: z.string().min(1).nullable().optional(),
  name: z.string().min(3).max(32),
  joinHost: z.string().min(3),
  joinPort: z.number().int().positive(),
  edition: z.enum(['java', 'bedrock']),
  supportedVersions: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string()),
  shortDescription: z.string().min(1).max(160),
  verificationGrade: serverVerificationGradeSchema,
  verifiedAt: z.string().datetime().optional(),
  votes24h: z.number().int().nonnegative(),
  votesMonthly: z.number().int().nonnegative().optional(),
  reviewsCount: z.number().int().nonnegative(),
  voteRequiresOwnership: z.boolean().optional(),
  bannerUrl: z.string().url().nullable().optional(),
  websiteUrl: z.string().url().nullable().optional(),
  playersOnline: z.number().int().nonnegative().nullable().optional(),
  playersMax: z.number().int().nonnegative().nullable().optional(),
  playersLastUpdatedAt: z.string().datetime().nullable().optional(),
  isOnline: z.boolean().nullable().optional(),
  latencyMs: z.number().int().nonnegative().nullable().optional(),
  rank: z
    .object({
      current: z.number().int().positive(),
      delta24h: z.number().int(),
      best: z.number().int().positive(),
      updatedAt: z.string().datetime(),
    })
    .nullable()
    .optional(),
});

export const serverDetailSchema = serverSummarySchema.extend({
  wikiUrl: z.string().min(1).nullable(),
  longDescription: z.string().min(1),
  bannerUrl: z.string().url().nullable(),
  websiteUrl: z.string().url().nullable(),
  discordUrl: z.string().url().nullable(),
  voteCooldownHours: z.number().int().positive(),
  verificationMethods: z.array(claimMethodSchema),
  createdAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),
});

export const serverRankingResponseSchema = z.object({
  items: z.array(serverSummarySchema),
  total: z.number().int().nonnegative(),
  summary: z.object({
    online: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    votes24h: z.number().int().nonnegative(),
  }),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  rankUpdatedAt: z.string().datetime().nullable(),
  rankEpoch: z.string().datetime().nullable(),
  rankStatus: z.enum(['ready', 'empty']),
  unrankedCount: z.number().int().nonnegative(),
});

export const serverRegistrationSchema = z.object({
  name: z.string().min(3).max(32),
  joinHost: z.string().min(3).max(255),
  joinPort: z.number().int().min(1).max(65535),
  edition: z.enum(['java', 'bedrock']),
  supportedVersions: z.array(z.string().min(1)).min(1).max(8),
  tags: z.array(z.string().min(1)).max(12),
  shortDescription: z.string().min(1).max(160),
  longDescription: z.string().min(1),
  websiteUrl: z.string().url().optional().nullable(),
  discordUrl: z.string().url().optional().nullable(),
});

export const serverPingSampleSchema = z.object({
  timestamp: z.string().datetime(),
  online: z.boolean(),
  players: z.number().int().nonnegative().nullable().optional(),
  maxPlayers: z.number().int().nonnegative().nullable().optional(),
  latency: z.number().int().nonnegative().nullable().optional(),
});

export const serverStatsSchema = z.object({
  serverId: z.string().uuid(),
  rank: z.object({
    current: z.number().int().nonnegative(),
    delta24h: z.number().int(),
    best: z.number().int().nonnegative(),
  }),
  votes: z.object({
    last24h: z.number().int().nonnegative(),
    last7d: z.number().int().nonnegative(),
    monthToDate: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative(),
  }),
  players: z.object({
    online: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime().nullable().optional(),
  }),
  uptimePercent: z.number().min(0).max(100),
  sparkline: z.array(z.number()),
  latencyMs: z.number().int().nonnegative().optional(),
  lastPingAt: z.string().datetime().nullable().optional(),
  pingSamples: z.array(serverPingSampleSchema).optional(),
});

export const serverUpdateTypeSchema = z.enum([
  'system',
  'verification',
  'review',
  'vote',
  'claim',
]);

export const serverUpdateSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().uuid(),
  type: serverUpdateTypeSchema,
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  occurredAt: z.string().datetime(),
  actorDisplayName: z.string().min(1).max(32).optional(),
});

export const reviewTagSchema = z.enum([
  'performance',
  'community',
  'staff',
  'stability',
  'content',
  'economy',
]);

export const reviewTrustLabelSchema = z.enum([
  'ms_owned',
  'vote_ack',
  'plugin_in_game',
  'discord_linked',
]);

export const reviewVisibilitySchema = z.enum(['public', 'staff']);
export const viewerReviewReportStatusSchema = z.enum([
  'none',
  'open',
  'in_review',
  'resolved',
  'dismissed',
]);

export const reviewAdminReplySchema = z.object({
  authorDisplayName: z.string().min(1).max(32),
  body: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
});

export const serverReviewSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  authorDisplayName: z.string().min(1).max(24),
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(80),
  tags: z.array(reviewTagSchema).max(3),
  trustLabels: z.array(reviewTrustLabelSchema),
  helpfulCount: z.number().int().nonnegative(),
  viewerHelpful: z.boolean(),
  viewerReportStatus: viewerReviewReportStatusSchema.optional(),
  reportCount: z.number().int().nonnegative().optional(),
  visibility: reviewVisibilitySchema,
  isAnonymous: z.boolean(),
  adminReply: reviewAdminReplySchema.nullable(),
  createdAt: z.string().datetime(),
  canManage: z.boolean().optional(),
});

export const serverReviewAggregateSchema = z.object({
  total: z.number().int().nonnegative(),
  average: z.number().min(1).max(5).nullable(),
  histogram: z.object({
    '1': z.number().int().nonnegative(),
    '2': z.number().int().nonnegative(),
    '3': z.number().int().nonnegative(),
    '4': z.number().int().nonnegative(),
    '5': z.number().int().nonnegative(),
  }),
});

export const serverReviewPageSchema = z.object({
  items: z.array(serverReviewSchema),
  nextCursor: z.string().min(1).max(2048).nullable(),
  aggregate: serverReviewAggregateSchema,
});

export const serverReviewFeedPageSchema = z.object({
  items: z.array(serverReviewSchema),
  nextCursor: z.string().min(1).max(2048).nullable(),
  aggregate: serverReviewAggregateSchema,
});

export const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(80),
  tags: z.array(reviewTagSchema).max(3),
  anonymous: z.boolean().optional(),
  visibility: reviewVisibilitySchema.optional(),
});

export const reviewGateStatusSchema = z.object({
  isLoggedIn: z.boolean(),
  isMinecraftOwned: z.boolean(),
  hasRecentVote: z.boolean(),
  lastVoteAt: z.string().datetime().nullable(),
  nextEligibleVoteAt: z.string().datetime().nullable(),
  displayName: z.string().min(1).max(32).nullable(),
  minecraftUuid: z.string().uuid().nullable(),
});

export const serverReferralSchema = z.object({
  username: z.string().min(1).max(16),
  votedAt: z.string().datetime(),
});

export const oauthProviderAvailabilitySchema = z.object({
  discord: z.boolean(),
  naver: z.boolean(),
});

export const dashboardServerSummarySchema = z.object({
  id: z.string().uuid(),
  shortCode: z.string().min(5).max(12).regex(/^[a-z0-9]+$/).nullable().optional(),
  name: z.string().min(1),
  votes24h: z.number().int().nonnegative(),
  votesMonthly: z.number().int().nonnegative().optional(),
  reviewsCount: z.number().int().nonnegative(),
  verificationGrade: serverVerificationGradeSchema,
  voteRequiresOwnership: z.boolean(),
  isPendingClaim: z.boolean().optional(),
  lastSyncedAt: z.string().datetime().nullable().optional(),
});

export const dashboardActivityItemSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  serverName: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(reviewTagSchema),
  createdAt: z.string().datetime(),
});

export const dashboardVerificationTaskSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string().min(1),
  method: claimMethodSchema,
  status: z.enum(['pending', 'verified', 'expired', 'failed']),
  lastCheckedAt: z.string().datetime().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const dashboardOverviewSchema = z.object({
  servers: z.array(dashboardServerSummarySchema),
  activity: z.array(dashboardActivityItemSchema),
  verification: z.array(dashboardVerificationTaskSchema),
});

export const supportTicketStatusSchema = z.enum(['open', 'pending', 'resolved', 'closed']);
export const supportTicketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const supportMessageAuthorRoleSchema = z.enum(['customer', 'agent', 'system']);

export const supportTicketAccountSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(64),
});

export const supportTicketServerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
});

export const supportMessageSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  authorAccountId: z.string().uuid().nullable(),
  authorDisplayName: z.string().min(1).max(64),
  authorRole: supportMessageAuthorRoleSchema,
  body: z.string().min(1).max(2000),
  isInternal: z.boolean(),
  createdAt: z.string().datetime(),
});

export const supportTicketSchema = z.object({
  id: z.string().uuid(),
  subject: z.string().min(1).max(160),
  status: supportTicketStatusSchema,
  priority: supportTicketPrioritySchema,
  category: z.string().min(1).max(40).nullable(),
  pageId: z.string().min(1).max(64).nullable(),
  verifySessionId: z.string().min(1).max(64).nullable(),
  pluginServerId: z.string().min(1).max(64).nullable(),
  fileId: z.string().min(1).max(64).nullable(),
  lastMessageAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  requester: supportTicketAccountSchema,
  assignee: supportTicketAccountSchema.nullable(),
  server: supportTicketServerSchema.nullable(),
  latestMessagePreview: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
});

export const supportTicketListResponseSchema = z.object({
  items: z.array(supportTicketSchema),
  viewer: z.object({
    isAgent: z.boolean(),
  }),
});

export const supportTicketDetailSchema = z.object({
  ticket: supportTicketSchema,
  messages: z.array(supportMessageSchema),
  viewer: z.object({
    isAgent: z.boolean(),
    canManage: z.boolean(),
  }),
});

export const createSupportTicketSchema = z.object({
  subject: z.string().min(1).max(160),
  body: z.string().min(1).max(2000),
  category: z.string().min(1).max(40).optional(),
  priority: supportTicketPrioritySchema.optional(),
  serverId: z.string().uuid().nullable().optional(),
  pageId: z.string().min(1).max(64).nullable().optional(),
  verifySessionId: z.string().min(1).max(64).nullable().optional(),
  pluginServerId: z.string().min(1).max(64).nullable().optional(),
  fileId: z.string().min(1).max(64).nullable().optional(),
});

export const createGuestSupportTicketSchema = createSupportTicketSchema.extend({
  guestName: z.string().min(1).max(64).optional(),
  guestEmail: z.string().email().max(120).optional(),
  captchaToken: z.string().trim().min(1).optional(),
});

export const createSupportMessageSchema = z.object({
  body: z.string().min(1).max(2000),
  isInternal: z.boolean().optional(),
});

export const updateSupportTicketSchema = z.object({
  status: supportTicketStatusSchema.optional(),
  priority: supportTicketPrioritySchema.optional(),
  assigneeAccountId: z.string().uuid().nullable().optional(),
  category: z.string().min(1).max(40).nullable().optional(),
});

export const votifierTargetSchema = z.object({
  protocol: z.enum(['v2', 'v1']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1).optional(),
  tokenConfigured: z.boolean().optional(),
  publicKey: z.string().min(1).optional(),
});

export const voteDispatchTargetSchema = z.object({
  targetId: z.string().uuid(),
  dispatchAttemptId: z.string().uuid(),
});

export const voteDispatchJobSchema = z.object({
  voteId: z.string().uuid(),
  serverId: z.string().uuid(),
  targets: z.array(voteDispatchTargetSchema).min(1),
});

export const serverPingJobSchema = z.object({
  serverId: z.string().uuid(),
});

export const claimVerificationJobSchema = z.object({
  serverId: z.string().uuid(),
  method: claimMethodSchema,
  initiatedAt: z.string().datetime(),
});

export const rankAggregationJobSchema = z.object({
  processedAt: z.string().datetime(),
});

export const discordDigestJobSchema = z.object({
  guildId: z.string().min(1),
  scheduledFor: z.string().datetime(),
});

export const discordVerifySessionCreateRequestSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  requesterDiscordId: z.string().min(1),
}).strict();

export const discordVerifySessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  status: z.enum(['pending', 'linked', 'sync_pending', 'synced', 'failed', 'expired']),
  verificationUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

export const discordVerifyCompleteRequestSchema = z.object({
  completionToken: z.string().min(32).max(256),
  minecraftUuid: z.string().uuid(),
  playerName: z.string().min(3).max(16).optional(),
});

export const discordVerifySyncJobSchema = z.object({
  action: z.enum(['link', 'revoke']).optional(),
  sessionId: z.string().uuid(),
});

export const pluginSyncEventSchema = z.object({
  serverId: z.string().uuid().optional(),
  pluginServerId: z.string().min(1).optional(),
  discordUserId: z.string().min(1).optional(),
  minecraftUuid: z.string().uuid(),
  playerName: z.string().min(3).max(16).optional(),
  action: z.enum(['minecraft_verified', 'discord_linked', 'role_synced', 'nickname_synced']),
  payload: z.record(z.unknown()).optional(),
});

export type UserAccount = z.infer<typeof userAccountSchema>;
export type ServerSummary = z.infer<typeof serverSummarySchema>;
export type ServerDetail = z.infer<typeof serverDetailSchema>;
export type ServerRankingResponse = z.infer<typeof serverRankingResponseSchema>;
export type ServerStats = z.infer<typeof serverStatsSchema>;
export type ServerUpdate = z.infer<typeof serverUpdateSchema>;
export type ServerReview = z.infer<typeof serverReviewSchema>;
export type ServerReviewAggregate = z.infer<typeof serverReviewAggregateSchema>;
export type ServerReviewPage = z.infer<typeof serverReviewPageSchema>;
export type ServerReviewFeedPage = z.infer<typeof serverReviewFeedPageSchema>;
export type CreateReviewPayload = z.infer<typeof createReviewSchema>;
export type ReviewVisibility = z.infer<typeof reviewVisibilitySchema>;
export type ReviewAdminReply = z.infer<typeof reviewAdminReplySchema>;
export type MinecraftIdentity = z.infer<typeof minecraftIdentitySchema>;
export type MinecraftVerificationRequest = z.infer<typeof minecraftVerificationRequestSchema>;
export type MinecraftAuthorizationStartRequest = z.infer<
  typeof minecraftAuthorizationStartRequestSchema
>;
export type MinecraftAuthorizationStartResponse = z.infer<
  typeof minecraftAuthorizationStartResponseSchema
>;
export type VoteDispatchJob = z.infer<typeof voteDispatchJobSchema>;
export type VoteDispatchTarget = z.infer<typeof voteDispatchTargetSchema>;
export type ReviewGateStatus = z.infer<typeof reviewGateStatusSchema>;
export type VotifierTarget = z.infer<typeof votifierTargetSchema>;
export type ServerPingJob = z.infer<typeof serverPingJobSchema>;
export type ClaimVerificationJob = z.infer<typeof claimVerificationJobSchema>;
export type RankAggregationJob = z.infer<typeof rankAggregationJobSchema>;
export type DiscordDigestJob = z.infer<typeof discordDigestJobSchema>;
export type DiscordVerifySessionCreateRequest = z.infer<
  typeof discordVerifySessionCreateRequestSchema
>;
export type DiscordVerifySessionResponse = z.infer<
  typeof discordVerifySessionResponseSchema
>;
export type DiscordVerifyCompleteRequest = z.infer<typeof discordVerifyCompleteRequestSchema>;
export type DiscordVerifySyncJob = z.infer<typeof discordVerifySyncJobSchema>;
export type PluginSyncEvent = z.infer<typeof pluginSyncEventSchema>;
export type AuthProvider = z.infer<typeof authProviderSchema>;
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;
export type PolicyConsentStatus = z.infer<typeof policyConsentStatusSchema>;
export type AuthAccount = z.infer<typeof authAccountSchema>;
export type LinkedAccount = z.infer<typeof linkedAccountSchema>;
export type OAuthStartRequest = z.infer<typeof oauthStartRequestSchema>;
export type OAuthStartResponse = z.infer<typeof oauthStartResponseSchema>;
export type OAuthCompleteRequest = z.infer<typeof oauthCompleteRequestSchema>;
export type OAuthCompleteResponse = z.infer<typeof oauthCompleteResponseSchema>;
export type EmailRegistrationRequest = z.infer<typeof emailRegistrationRequestSchema>;
export type EmailLoginRequest = z.infer<typeof emailLoginRequestSchema>;
export type EmailVerificationRequest = z.infer<typeof emailVerificationRequestSchema>;
export type EmailResendRequest = z.infer<typeof emailResendRequestSchema>;
export type EmailLoginSetupRequest = z.infer<typeof emailLoginSetupRequestSchema>;
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;
export type PasswordResetConfirmRequest = z.infer<typeof passwordResetConfirmRequestSchema>;
export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;
export type AccountDeletionCancel = z.infer<typeof accountDeletionCancelSchema>;
export type AccountLifecycleStatus = z.infer<typeof accountLifecycleStatusSchema>;
export type AccountModerationAction = z.infer<typeof accountModerationActionSchema>;
export type AccountSuspendAction = z.infer<typeof accountSuspendActionSchema>;
export type AccountRestoreAction = z.infer<typeof accountRestoreActionSchema>;
export type AdminAccountListQuery = z.infer<typeof adminAccountListQuerySchema>;
export type AdminAccountSummary = z.infer<typeof adminAccountSummarySchema>;
export type AdminAccountMember = z.infer<typeof adminAccountMemberSchema>;
export type AccountModerationHistoryEntry = z.infer<typeof accountModerationHistoryEntrySchema>;
export type AdminAccountDetail = z.infer<typeof adminAccountDetailSchema>;
export type AdminAccountListResponse = z.infer<typeof adminAccountListResponseSchema>;
export type AccountModerationResult = z.infer<typeof accountModerationResultSchema>;
export type EmailRegistrationResult = z.infer<typeof emailRegistrationResultSchema>;
export type ResendVerificationResult = z.infer<typeof resendVerificationResultSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type ServerRegistrationPayload = z.infer<typeof serverRegistrationSchema>;
export type ServerPingSample = z.infer<typeof serverPingSampleSchema>;
export type ServerReferral = z.infer<typeof serverReferralSchema>;
export type OAuthProviderAvailability = z.infer<typeof oauthProviderAvailabilitySchema>;
export type DashboardServerSummary = z.infer<typeof dashboardServerSummarySchema>;
export type DashboardActivityItem = z.infer<typeof dashboardActivityItemSchema>;
export type DashboardVerificationTask = z.infer<typeof dashboardVerificationTaskSchema>;
export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>;
export type SupportTicketStatus = z.infer<typeof supportTicketStatusSchema>;
export type SupportTicketPriority = z.infer<typeof supportTicketPrioritySchema>;
export type SupportMessageAuthorRole = z.infer<typeof supportMessageAuthorRoleSchema>;
export type SupportTicketAccount = z.infer<typeof supportTicketAccountSchema>;
export type SupportTicketServer = z.infer<typeof supportTicketServerSchema>;
export type SupportMessage = z.infer<typeof supportMessageSchema>;
export type SupportTicket = z.infer<typeof supportTicketSchema>;
export type SupportTicketListResponse = z.infer<typeof supportTicketListResponseSchema>;
export type SupportTicketDetail = z.infer<typeof supportTicketDetailSchema>;
export type CreateSupportTicketPayload = z.infer<typeof createSupportTicketSchema>;
export type CreateGuestSupportTicketPayload = z.infer<typeof createGuestSupportTicketSchema>;
export type CreateSupportMessagePayload = z.infer<typeof createSupportMessageSchema>;
export type UpdateSupportTicketPayload = z.infer<typeof updateSupportTicketSchema>;
