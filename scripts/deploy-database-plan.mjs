export function planDatabaseDeployment(tables) {
  const tableSet = new Set(tables);
  const hasMigrationHistory = tableSet.has('_prisma_migrations');
  const applicationTables = tables.filter((table) => table !== '_prisma_migrations');

  if (applicationTables.length === 0 && !hasMigrationHistory) {
    return {
      kind: 'bootstrap',
      applicationTableCount: 0,
    };
  }

  if (applicationTables.length > 0 && hasMigrationHistory) {
    return {
      kind: 'migrate',
      applicationTableCount: applicationTables.length,
    };
  }

  if (applicationTables.length > 0) {
    throw new Error(
      'Refusing to modify a non-empty database without Prisma migration history. ' +
        'Restore a verified backup or perform a separately reviewed legacy adoption; ' +
        'the production deploy command never runs prisma db push against existing data.',
    );
  }

  throw new Error(
    'Refusing to bootstrap a database that has Prisma migration history but no application tables. ' +
      'Restore or inspect the database instead of deleting migration history automatically.',
  );
}
