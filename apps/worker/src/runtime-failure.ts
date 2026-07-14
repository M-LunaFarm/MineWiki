export interface FatalRunLoopFailureOptions {
  readonly error: unknown;
  readonly workerName: string;
  readonly isShuttingDown: () => boolean;
  readonly markShuttingDown: () => void;
  readonly closeResources: () => Promise<void>;
  readonly logFailure: (error: unknown, workerName: string) => void;
  readonly exit: (code: number) => void;
}

export async function terminateOnRunLoopFailure(
  options: FatalRunLoopFailureOptions,
): Promise<void> {
  if (options.isShuttingDown()) return;
  options.markShuttingDown();
  options.logFailure(options.error, options.workerName);
  try {
    await options.closeResources();
  } finally {
    options.exit(1);
  }
}
