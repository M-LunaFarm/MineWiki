import { Readable } from 'node:stream';

export interface AccountExportSection<Row extends object = Record<string, unknown>> {
  readonly name: string;
  readonly load: (after: string | null) => Promise<readonly Row[]>;
  readonly cursor: (row: Row) => string;
}

export interface AccountExportMetadata {
  readonly generatedAt: Date;
  readonly canonicalAccountId: string;
  readonly accountIds: readonly string[];
  readonly profileIds: readonly string[];
}

export function createAccountExportStream(
  metadata: AccountExportMetadata,
  sections: readonly AccountExportSection[],
): Readable {
  return Readable.from(serializeAccountExport(metadata, sections));
}

async function* serializeAccountExport(
  metadata: AccountExportMetadata,
  sections: readonly AccountExportSection[],
): AsyncGenerator<string> {
  yield '{"format":"minewiki-account-export","version":1,"generatedAt":';
  yield stringify(metadata.generatedAt);
  yield ',"scope":';
  yield stringify({
    canonicalAccountId: metadata.canonicalAccountId,
    accountIds: metadata.accountIds,
    profileIds: metadata.profileIds,
  });
  yield ',"data":{';

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex]!;
    if (sectionIndex > 0) yield ',';
    yield `${stringify(section.name)}:[`;
    let after: string | null = null;
    let firstRow = true;
    while (true) {
      const rows = await section.load(after);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!firstRow) yield ',';
        yield stringify(row);
        firstRow = false;
      }
      const next = section.cursor(rows[rows.length - 1]!);
      if (!next || next === after) throw new Error(`Account export section ${section.name} did not advance its cursor.`);
      after = next;
    }
    yield ']';
  }

  yield '},"completed":true}';
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => typeof candidate === 'bigint' ? candidate.toString() : candidate);
}
