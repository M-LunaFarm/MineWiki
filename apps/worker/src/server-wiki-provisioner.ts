export async function provisionClaimedServerWiki(input: {
  readonly apiBaseUrl: string;
  readonly internalToken: string;
  readonly serverId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${input.apiBaseUrl.replace(/\/$/u, '')}/v1/internal/server-wikis/${encodeURIComponent(input.serverId)}/provision`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.internalToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(`Server wiki provisioning failed with status ${response.status}.`);
  }
}
